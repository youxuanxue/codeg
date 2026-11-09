//! Answering an agent's question by replying to its chat push.
//!
//! The `question_request` push is an ordinary chat message. Replying to it
//! (the IM's own reply/quote, no command, no mention needed) answers the
//! question: the reply text goes to the agent as typed. The agent reads natural
//! language, so a reply needs no format — "the first, and skip the second"
//! answers two questions at once.
//!
//! The link between a sent push and the question it asked lives in memory
//! only: a restart forgets it, and a reply to an older push is told to answer
//! in Codeg. Pushes are few (one per question the user is actually asked), so
//! the map is small; it is still bounded.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use tokio::sync::Mutex;

use super::i18n::{self, Lang};
use super::types::{ChannelType, IncomingCommand, RichMessage};
use crate::acp::manager::ConnectionManager;
use crate::acp::question::{QuestionAnswer, QuestionAnswerItem, QuestionSpec};

/// Most question pushes remembered; the oldest is forgotten first.
const MAX_TRACKED: usize = 256;

/// What a reply addresses: the connection asking and its question id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionRef {
    pub connection_id: String,
    pub question_id: String,
}

#[derive(Default)]
struct Registry {
    /// `(channel id, sent message id)` → the question it pushed.
    by_message: HashMap<(i32, String), QuestionRef>,
    /// Insertion order, for the bound.
    order: Vec<(i32, String)>,
}

static REGISTRY: LazyLock<Arc<Mutex<Registry>>> = LazyLock::new(Default::default);

/// Remember that `message_id`, sent on `channel_id`, asked `question`.
pub async fn track(channel_id: i32, message_id: &str, question: QuestionRef) {
    if message_id.is_empty() {
        return;
    }
    let key = (channel_id, message_id.to_string());
    let mut reg = REGISTRY.lock().await;
    if reg.by_message.insert(key.clone(), question).is_none() {
        reg.order.push(key);
    }
    while reg.order.len() > MAX_TRACKED {
        let oldest = reg.order.remove(0);
        reg.by_message.remove(&oldest);
    }
}

/// The question a push asked, if this process sent it.
pub async fn lookup(channel_id: i32, message_id: &str) -> Option<QuestionRef> {
    REGISTRY
        .lock()
        .await
        .by_message
        .get(&(channel_id, message_id.to_string()))
        .cloned()
}

/// The message an inbound chat message replies to, for the backends that say.
fn replied_message_id(cmd: &IncomingCommand) -> Option<&str> {
    super::backends::lark::lark_reply_parent_id(&cmd.metadata)
}

/// A group-chat reply that does not mention the bot. The backend lets these
/// through only so they can answer a question push; any other one is dropped,
/// as a mention-less group message always was.
pub fn is_unaddressed_group_reply(cmd: &IncomingCommand) -> bool {
    let event = &cmd.metadata;
    let group = event
        .pointer("/event/message/chat_type")
        .and_then(|v| v.as_str())
        == Some("group");
    let mentioned = event
        .pointer("/event/message/mentions")
        .and_then(|v| v.as_array())
        .is_some_and(|m| !m.is_empty());
    group && !mentioned && replied_message_id(cmd).is_some()
}

/// Whether `cmd` replies to a question push this process sent.
pub async fn replies_to_tracked_question(cmd: &IncomingCommand) -> bool {
    match replied_message_id(cmd) {
        Some(parent) => lookup(cmd.channel_id, parent).await.is_some(),
        None => false,
    }
}

/// Answer the question `cmd` replies to, returning the receipt to send back.
/// `None` when `cmd` is not a reply to a tracked question push: the message
/// then goes through ordinary command dispatch. A group reply to anything
/// else carries no mention and is ignored there, as before.
pub async fn answer_reply(
    cmd: &IncomingCommand,
    conn_mgr: &ConnectionManager,
    lang: Lang,
) -> Option<RichMessage> {
    let parent = replied_message_id(cmd)?;
    let question = lookup(cmd.channel_id, parent).await?;
    let Some(specs) = conn_mgr.pending_question_specs(&question.question_id).await else {
        return Some(RichMessage::info(i18n::question_reply_gone(lang)));
    };
    let answer = answer_from_reply(&specs, &cmd.command_text);
    let declined = answer.declined;
    match conn_mgr
        .answer_question(&question.connection_id, &question.question_id, answer)
        .await
    {
        Ok(()) => Some(RichMessage::info(if declined {
            i18n::question_reply_deferred(lang)
        } else {
            i18n::question_reply_sent(lang)
        })),
        Err(e) => Some(RichMessage::error(format!(
            "{}{e}",
            i18n::question_reply_failed(lang)
        ))),
    }
}

/// Replies that hand the decision back to the agent instead of answering.
const DEFER_REPLIES: &[&str] = &[
    "跳过",
    "你定",
    "你决定",
    "随便",
    "skip",
    "pass",
    "you decide",
    "your call",
];

/// The answer a reply gives. Every question receives the reply text as its
/// answer (as the card's free-text "Other" would), prefixed when several were
/// asked at once so the agent knows one reply covers them all. A reply that
/// defers — "skip", "你定" — declines, and the agent proceeds on its own.
pub fn answer_from_reply(questions: &[QuestionSpec], reply: &str) -> QuestionAnswer {
    let text = reply.trim();
    if text.is_empty() || DEFER_REPLIES.iter().any(|d| text.eq_ignore_ascii_case(d)) {
        return QuestionAnswer {
            answers: Vec::new(),
            declined: true,
        };
    }
    let label = if questions.len() > 1 {
        format!("(One reply to all {} questions) {text}", questions.len())
    } else {
        text.to_string()
    };
    QuestionAnswer {
        answers: questions
            .iter()
            .map(|q| QuestionAnswerItem {
                question_id: q.id.clone(),
                labels: vec![label.clone()],
            })
            .collect(),
        declined: false,
    }
}

/// Whether a channel tells codeg which message a reply quotes. Only those can
/// answer a question by reply; the others keep "answer it in Codeg".
pub fn channel_supports_reply(channel_type: Option<ChannelType>) -> bool {
    channel_type == Some(ChannelType::Lark)
}

/// Whether a question set can be answered from chat at all. A secret question
/// (an API key) must never travel through a chat channel and its log.
pub fn answerable_from_chat(questions: &[QuestionSpec]) -> bool {
    !questions.is_empty() && questions.iter().all(|q| !q.is_secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::question::QuestionOption;

    fn spec(id: &str, secret: bool) -> QuestionSpec {
        QuestionSpec {
            id: id.into(),
            question: format!("question {id}?"),
            header: "Pick".into(),
            multi_select: false,
            options: vec![QuestionOption {
                label: "A".into(),
                description: String::new(),
            }],
            is_secret: secret,
        }
    }

    #[test]
    fn a_reply_answers_the_question_verbatim() {
        let a = answer_from_reply(&[spec("q1", false)], "  先做 MVP，机器等稳定后再买 ");
        assert!(!a.declined);
        assert_eq!(a.answers.len(), 1);
        assert_eq!(a.answers[0].question_id, "q1");
        assert_eq!(a.answers[0].labels, vec!["先做 MVP，机器等稳定后再买"]);
    }

    #[test]
    fn one_reply_covers_every_question_and_says_so() {
        let a = answer_from_reply(
            &[spec("q1", false), spec("q2", false)],
            "第一个现在买，第二个不急",
        );
        assert_eq!(a.answers.len(), 2);
        for item in &a.answers {
            assert_eq!(item.labels.len(), 1);
            assert!(item.labels[0].contains("第一个现在买，第二个不急"));
            assert!(item.labels[0].contains("all 2 questions"));
        }
    }

    #[test]
    fn deferring_replies_decline() {
        for reply in ["跳过", "你定", "Skip", "  ", ""] {
            let a = answer_from_reply(&[spec("q1", false)], reply);
            assert!(a.declined, "{reply:?} should decline");
            assert!(a.answers.is_empty());
        }
    }

    #[test]
    fn secret_questions_are_not_answerable_from_chat() {
        assert!(answerable_from_chat(&[spec("q1", false)]));
        assert!(!answerable_from_chat(&[
            spec("q1", false),
            spec("q2", true)
        ]));
        assert!(!answerable_from_chat(&[]));
    }

    #[tokio::test]
    async fn tracked_pushes_resolve_and_the_map_stays_bounded() {
        let q = |n: usize| QuestionRef {
            connection_id: "c".into(),
            question_id: format!("q{n}"),
        };
        track(9001, "", q(0)).await;
        assert_eq!(lookup(9001, "").await, None);
        for n in 0..MAX_TRACKED + 5 {
            track(9001, &format!("m{n}"), q(n)).await;
        }
        assert_eq!(lookup(9001, "m0").await, None, "oldest forgotten");
        assert_eq!(
            lookup(9001, &format!("m{}", MAX_TRACKED + 4)).await,
            Some(q(MAX_TRACKED + 4))
        );
        assert_eq!(lookup(9002, "m10").await, None, "keyed by channel too");
    }

    fn lark_reply(channel_id: i32, parent: &str, text: &str, mentioned: bool) -> IncomingCommand {
        let mentions = if mentioned {
            serde_json::json!([{ "key": "@_user_1" }])
        } else {
            serde_json::json!([])
        };
        IncomingCommand {
            channel_id,
            sender_id: "ou_x".into(),
            command_text: text.into(),
            callback_data: None,
            target: crate::chat_channel::types::ChannelMessageTarget::channel(channel_id),
            metadata: serde_json::json!({
                "event": { "message": {
                    "chat_type": "group",
                    "parent_id": parent,
                    "mentions": mentions,
                }}
            }),
        }
    }

    async fn pending(
        mgr: &ConnectionManager,
        conn: &str,
    ) -> crate::acp::question::RegisteredQuestion {
        use crate::models::agent::AgentType;
        use crate::web::event_bridge::EventEmitter;
        mgr.insert_test_connection(conn, AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mgr.register_question(conn, vec![spec("qa", false)])
            .await
            .expect("registered")
    }

    /// A reply to a tracked push reaches the blocked agent as typed, and a
    /// second reply to the same push is told the question is gone.
    #[tokio::test]
    async fn a_reply_to_the_push_answers_the_agent() {
        let mgr = ConnectionManager::new();
        let reg = pending(&mgr, "conn-reply").await;
        track(
            9101,
            "om_push",
            QuestionRef {
                connection_id: "conn-reply".into(),
                question_id: reg.question_id.clone(),
            },
        )
        .await;

        let cmd = lark_reply(9101, "om_push", "先做 MVP", false);
        assert!(is_unaddressed_group_reply(&cmd));
        assert!(replies_to_tracked_question(&cmd).await);
        let receipt = answer_reply(&cmd, &mgr, Lang::ZhCn).await.expect("handled");
        assert_eq!(receipt.body, i18n::question_reply_sent(Lang::ZhCn));

        let outcome = reg.answer_rx.await.expect("agent got an answer");
        assert!(!outcome.declined);
        assert_eq!(outcome.answers[0].selected, vec!["先做 MVP".to_string()]);

        let again = answer_reply(&cmd, &mgr, Lang::ZhCn).await.expect("handled");
        assert_eq!(again.body, i18n::question_reply_gone(Lang::ZhCn));
    }

    #[tokio::test]
    async fn skip_declines_so_the_agent_decides() {
        let mgr = ConnectionManager::new();
        let reg = pending(&mgr, "conn-skip").await;
        track(
            9102,
            "om_push",
            QuestionRef {
                connection_id: "conn-skip".into(),
                question_id: reg.question_id.clone(),
            },
        )
        .await;

        let receipt = answer_reply(
            &lark_reply(9102, "om_push", "你定", false),
            &mgr,
            Lang::ZhCn,
        )
        .await
        .expect("handled");
        assert_eq!(receipt.body, i18n::question_reply_deferred(Lang::ZhCn));
        assert!(reg.answer_rx.await.expect("resolved").declined);
    }

    /// Replies to anything but a tracked push are not answers: a reply to
    /// another message, a reply on another channel, a plain message.
    #[tokio::test]
    async fn other_messages_are_left_to_command_dispatch() {
        let mgr = ConnectionManager::new();
        let reg = pending(&mgr, "conn-other").await;
        track(
            9103,
            "om_push",
            QuestionRef {
                connection_id: "conn-other".into(),
                question_id: reg.question_id.clone(),
            },
        )
        .await;

        let unrelated = lark_reply(9103, "om_someone_else", "哈哈", false);
        assert!(answer_reply(&unrelated, &mgr, Lang::ZhCn).await.is_none());
        assert!(is_unaddressed_group_reply(&unrelated));
        assert!(!replies_to_tracked_question(&unrelated).await);

        let other_channel = lark_reply(9104, "om_push", "先做 MVP", false);
        assert!(answer_reply(&other_channel, &mgr, Lang::ZhCn)
            .await
            .is_none());

        let mut plain = lark_reply(9103, "", "/status", true);
        plain.metadata["event"]["message"]
            .as_object_mut()
            .unwrap()
            .remove("parent_id");
        assert!(answer_reply(&plain, &mgr, Lang::ZhCn).await.is_none());
        assert!(!is_unaddressed_group_reply(&plain));

        // A mentioned reply to an unrelated message is still a command.
        assert!(!is_unaddressed_group_reply(&lark_reply(
            9103, "om_x", "/status", true
        )));
        assert!(
            mgr.pending_question_specs(&reg.question_id).await.is_some(),
            "still pending"
        );
    }
}

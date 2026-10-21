import { isAdminMessage, matchMessage } from './filter.js';
import { logError } from './errors.js';

export function createHandler(store, commands) {
  return async event => {
    const message = event.message;
    if (!message) return;
    try {
      if (isAdminMessage(message)) {
        await commands.handle(message);
        return;
      }
      const match = matchMessage(store, message);
      if (!match) return;
      const ids = [];
      // The replied-to ID is in this same chat. Cross-chat replies are not
      // fetched or forwarded, and no historical conversation is downloaded.
      const reply = message.replyTo;
      const isTopicHeader = reply?.forumTopic && (!reply.replyToTopId || reply.replyToMsgId === reply.replyToTopId);
      if (match.includeReply && reply?.replyToMsgId && !reply.replyToPeerId && !isTopicHeader) ids.push(reply.replyToMsgId);
      ids.push(message.id);
      store.enqueue(match.source, ids, match.destination, match.rule.id);
    } catch (error) { logError('event', error); }
  };
}

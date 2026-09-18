import { useParams } from 'react-router-dom';
import Conversation from './Conversation';

/**
 * One of the reader's own conversations, opened on their account rather than on
 * a link: /account/messages/:id.
 *
 * THE DOOR THAT DID NOT EXIST, and the owner's description of why it had to:
 * "there has to be a way for a business and client to continue a conversation
 * without needing to keep a link."
 *
 * Booking has created a customer account since migration 0037, and /account has
 * listed every booking on it ever since. The conversation about those bookings
 * was not listed anywhere. It lived behind the /c/:token link and nothing else
 * — and because only a peppered fingerprint of that token is stored, on
 * purpose, nobody on this site was able to hand one back. So a customer who
 * cleared their history or lost the confirmation email had a proved email
 * address, an account, and a booking they could see the price of, while the
 * messages agreeing what the work was, the photographs they had taken of their
 * own kitchen, the four digits their tradesman needs on the doorstep and the
 * card form for a booking nobody had charged them for were all unreachable.
 * The page even told them so: "keep this link, it is the only way to this
 * conversation."
 *
 * Migration 0052 put the account on the thread. This is the other end of it.
 *
 * THE ID IN THE ADDRESS IS NOT A SECRET AND IS NOT THE AUTHORITY. The session
 * cookie is; the id only says which conversation is meant. An id belonging to
 * another account answers 404 in the same words a made-up one gets — see
 * threadForCustomer in src/lib/chat.ts, which is scoped in the WHERE clause the
 * same way the operator's own inbox has been since 0011. That is also why this
 * route is safe to have in a URL at all, where a token would not be.
 */
export default function AccountThread() {
  const { id } = useParams<{ id: string }>();
  return <Conversation threadRef={id ?? ''} door="account" />;
}

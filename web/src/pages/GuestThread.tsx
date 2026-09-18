import { useParams } from 'react-router-dom';
import Conversation from './Conversation';

/**
 * The customer's conversation, opened on the secret in their link: /c/:token.
 *
 * THE WHOLE PAGE MOVED TO Conversation.tsx AND NOTHING ABOUT THIS DOOR
 * CHANGED. There are two ways to a conversation since migration 0052 — this
 * one, and a signed-in customer opening it from their account — and every
 * single thing drawn on the screen is the same in both: the booking card, the
 * money line, the card form for a booking nobody has paid for, the quotes, the
 * refund question, the start code, the parts approval, the photo strip, the
 * transcript, the composer, the erasure.
 *
 * So this file is a wrapper rather than a copy, and that is a deliberate
 * choice about where the risk is. A second copy of that page would have been a
 * second copy of the unpaid-booking panel and the money logic around it, and
 * the first time the two drifted the failure would be a customer charged twice
 * or told they had paid when they had not. One implementation cannot drift.
 *
 * WHY THIS DOOR IS NOT GOING ANYWHERE. The token in the address bar is the
 * whole authority here: it works on a phone that has never been signed in,
 * which is how somebody reads a message from the business while standing in
 * their own driveway, and it is all a guest who never made an account has ever
 * had. Nothing was narrowed to make room for the account door — see
 * guardGuestLink in src/lib/guestlink.ts, where the token is tried first and
 * a valid one never causes a session to be looked at.
 */
export default function GuestThread() {
  const { token } = useParams<{ token: string }>();
  return <Conversation threadRef={token ?? ''} door="link" />;
}

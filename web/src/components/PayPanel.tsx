import { useId, type ReactNode } from 'react';
import PayForm from './PayForm';

/**
 * AN ORDER THAT EXISTS AND HAS NOT BEEN PAID FOR, WITH THE CARD FORM FOR IT.
 *
 * WHY THIS IS A COMPONENT AND NOT MARKUP ON A PAGE. There are now two places a
 * customer can arrive holding a booking nobody has charged for. The checkout
 * makes one every time somebody presses Book — the appointments are held, the
 * order is written 'pending', and the charge is a second request. Accepting a
 * price quote on the conversation page makes the other one, and until an hour
 * ago it made nothing else at all: the acceptance was recorded and no booking
 * and no charge ever followed. Both now end in the same state, which is the
 * single most dangerous state this product has — the customer believes they
 * have bought something, the operator's calendar says a job is happening, and
 * no money has moved.
 *
 * So the rules for getting out of that state are written down once, here,
 * rather than typed out twice and allowed to drift:
 *
 *   THE AMOUNT IS THE SERVER'S. `total` arrives already formatted — off
 *   priceOrder at the checkout, off the accepted estimate's order on the
 *   conversation page — and nothing in this component or below it adds to it,
 *   discounts it or works it out again. A figure a browser calculated that
 *   disagrees with the charge by a cent is a support ticket that costs more
 *   than the cent.
 *
 *   IT ALWAYS SAYS WHERE TO COME BACK TO. `comeBack` has no default and
 *   cannot be left out, because a panel that takes a card without telling
 *   somebody what happens if they close the tab is the panel that strands
 *   them. The two pages answer it differently — the checkout points at the
 *   conversation link, and the conversation page IS that link — so the
 *   sentence is the caller's and the requirement is this component's.
 *
 *   THE CARD FORM IS PayForm AND THERE IS NO SECOND ONE. Stripe's embedded
 *   Payment Element, on our own page, with the intent created
 *   allow_redirects=never and confirmed redirect:'if_required'. The customer
 *   never goes to the processor's website to pay. That is a product rule, not
 *   an implementation detail, and the way to keep it true is to have exactly
 *   one component that can take a card for an order.
 *
 * WHAT THIS DOES NOT OWN is what happens after the card clears. `onPaid` is a
 * screen change and never a receipt: the booking is confirmed by the processor
 * telling the Worker, server to server, because a customer whose phone dies the
 * second after they press Pay must still end up with a booking. The checkout
 * navigates to the conversation; the conversation page redraws itself. Neither
 * of them is the source of truth and neither is allowed to behave as though it
 * were.
 */

export interface PayPanelProps {
  orderId: string;
  /**
   * The amount, already formatted by whoever got it from the server. Never a
   * number this component turns into money — see the note above.
   */
  total: string;
  /** The heading. Short, and naming the thing being paid for. */
  title: string;
  /** One sentence under the heading: what is held, and what paying does to it. */
  lead: ReactNode;
  /** What happens if this tab closes, and how they finish. Required, on purpose. */
  comeBack: ReactNode;
  /** Called once the card has been accepted. A screen change, not a receipt. */
  onPaid: () => void;
  /**
   * The shell's classes, in full, because the two callers sit in different
   * sheets: the checkout's step cards are `card book-card book-step` out of
   * styles-book.css, and the conversation page has no such sheet loaded.
   * Passing the whole string rather than appending to a fixed `card` is what
   * lets this drop into either without carrying a stylesheet it does not need.
   */
  className?: string;
}

export default function PayPanel({
  orderId, total, title, lead, comeBack, onPaid, className = 'card',
}: PayPanelProps) {
  // Generated rather than fixed. Two panels on one page is not a shape either
  // caller draws today, but a duplicated id is the kind of bug that shows up
  // only in a screen reader — where it quietly labels the wrong region — and
  // costs nothing to rule out.
  const headingId = useId();

  return (
    <section className={className} aria-labelledby={headingId}>
      <h3 id={headingId} style={{ margin: 0 }}>{title}</h3>
      <p className="faint" style={{ marginTop: 0 }}>{lead}</p>
      <PayForm orderId={orderId} total={total} onPaid={onPaid} />
      {/* Said plainly and said last, because somebody who closes this tab needs
          to know their booking is not lost and is also not yet paid for. */}
      <p className="faint" style={{ margin: 0 }}>{comeBack}</p>
    </section>
  );
}

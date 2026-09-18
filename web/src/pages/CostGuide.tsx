import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, sentence, type MapArea, type PublicSlot, type TradeCategory } from '../api';
import Crumbs from '../components/Crumbs';
// TWO IMPORT LINES FROM ONE MODULE, DELIBERATELY. test/public-payload.test.ts
// pins the first of them character for character: it is how the test proves
// this page's payment answer is built from the shared constant rather than
// from a paraphrase that would pass a looser check. The account constant is
// therefore imported beside it rather than folded into the same braces, which
// would break a pin that has nothing to do with the account.
import { PAY_TODAY_SHORT } from '../components/PaymentState';
import { ACCOUNT_TODAY_SHORT } from '../components/PaymentState';
import PublicPage from '../components/PublicPage';
import PostcodeFinder from '../components/PostcodeFinder';
import MetroLinks from '../components/MetroLinks';
import { ErrorNote, Spinner } from '../components/ui';
import '../styles-trade.css';
// The modules this page shares with /cost — the short answer, the per-place
// table, the factor list, the saving list and the call-to-action band. Kept out
// of styles-trade.css because the index page needs them too and does not load
// that sheet. See the header of styles-cost.css.
import '../styles-cost.css';
import { ENOUGH, formatMoney as money, median, plural } from '../lib/format';
import { useMetros } from '../lib/metros';
import { costHref, jsonLd, nearTradeHref, storedTradeSlug, tradeHref } from '../lib/seo';
import { distinctGaps } from '../lib/slots';
import { useDocumentTitle } from '../lib/title';

/**
 * What one trade costs, built only out of what is actually listed.
 * Route /cost/:trade.
 *
 * The reference marketplace's cost guides are the single biggest source of
 * their search traffic, and the reason is obvious: "what does X cost" is what
 * people type. Theirs are built on a national survey of jobs booked through
 * them. We do not have a national survey, we do not have national coverage,
 * and we are not going to invent either.
 *
 * What we do have is every price every business on this site is asking for
 * this trade, live, right now. So that is the whole page. The lowest, the
 * highest and the middle of the listed prices; then each service by name with
 * what it is listed at and how long it is listed for; then the three things
 * that genuinely change what you pay here, and the questions people ask about
 * where these figures came from.
 *
 * THE SENTENCE THAT MAKES THIS PAGE HONEST is the note near the top: these are
 * asking prices from businesses on Round The Way today, not an average of the trade.
 * It is set apart from the prose so it cannot be skimmed past, and it is the
 * only reason this page is allowed to exist at all. If that sentence ever gets
 * softened into "the average cost of X is", this page becomes the thing it was
 * written to avoid.
 *
 * When there is almost nothing listed, it says so rather than computing a
 * range out of two numbers and calling it typical. Two prices are two prices.
 */

/**
 * "1 hr 30 min", because "90 min" makes a reader do the arithmetic.
 *
 * Spelled out rather than api.ts's terse "1h 30m": this is prose in a sentence
 * on a page a stranger is reading, not a figure glanced at on a dashboard.
 * seo.ts renders the server side of this page and carries the same wording.
 */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * WHAT ACTUALLY DRIVES THE BILL IN EACH TRADE.
 *
 * The reference marketplace's price pages all carry a "what affects the price
 * of X" list, and it is the one module on such a page that is neither a figure
 * nor a claim about the marketplace. It is knowledge about the work: a car with
 * a dog in it takes longer to valet, a locksmith needs different kit for a
 * transponder key than for a night latch, a screen is most of the bill on a
 * phone repair. None of that is a statement about Round The Way, none of it needs
 * a survey behind it, and a page called "what does X cost" that cannot say why
 * one X costs more than another is not a cost guide, it is a price list.
 *
 * SO THIS IS THE ONE PLACE ON THESE PAGES WHERE THE WORDS ARE WRITTEN RATHER
 * THAN COUNTED, and the rules that keeps honest are worth stating:
 *
 *   1. Nothing here carries a number. Not a price, not a percentage, not "adds
 *      about a third". A written figure is exactly the invented average the
 *      rest of this page exists to refuse, and it would sit two sections below
 *      figures that were genuinely counted, where a reader has no way to tell
 *      the two apart. Every number on this page comes off the listings.
 *   2. Nothing here is a claim about the businesses on this site — not their
 *      training, not their equipment, not their insurance. These entries
 *      describe the work, not the people we list.
 *   3. A trade with no entry gets no section. The lookup below returns nothing
 *      for the pop-up retail trades, where the "price" is the price of goods
 *      rather than of work and there is nothing true to say about labour, and
 *      the section is simply not drawn. Writing a vague paragraph to fill the
 *      hole is how a page ends up padded with things nobody checked.
 *
 * Keyed by the catalogue's slug, which is the stored value on the operator row
 * and never changes once shipped — so a friendlier label can be reworded in
 * src/lib/trades.ts without silently detaching a trade from its own guide.
 */
interface TradeCosts {
  /** Named factor, and what it does to the work. Ordered by how much it moves. */
  factors: { h: string; p: string }[];
  /**
   * The do-it-yourself comparison, where there honestly is one. Omitted for
   * work where the only truthful answer is "do not", and for work where there
   * is no meaningful amateur version at all.
   */
  diy?: { yourself: string; pro: string };
  /** Ways the number genuinely comes down, none of them about our pricing. */
  saving?: string[];
}

const TRADE_COSTS: Record<string, TradeCosts> = {
  'mobile car wash and detailing': {
    factors: [
      { h: 'The size and shape of the vehicle',
        p: 'A three-door hatchback and a seven-seat van are the same job done '
          + 'over very different areas, and the van has more glass, more seats '
          + 'and more carpet in it. Roof height matters too — a high-sided van '
          + 'or a lifted truck has panels that cannot be reached from the '
          + 'ground.' },
      { h: 'What is actually on the car',
        p: 'Time is spent on contamination rather than on dirt. Baked-on brake '
          + 'dust, tree sap, tar, road salt and bird lime all need dwell time '
          + 'and a separate chemical each; pet hair woven into upholstery is '
          + 'lifted a section at a time and is often the single longest part of '
          + 'an interior. A car cleaned every month and a car cleaned once are '
          + 'not the same job.' },
      { h: 'Inside, outside, or both',
        p: 'These are priced as separate pieces of work almost everywhere, '
          + 'because they use different kit and different time. An exterior '
          + 'wash and an interior valet booked together will be listed '
          + 'differently from either on its own.' },
      { h: 'Wash, or paint correction',
        p: 'Washing removes what is sitting on the paint. Machine polishing '
          + 'removes a layer of the paint itself to take the scratches out, and '
          + 'is measured in hours per panel rather than minutes. A ceramic or '
          + 'wax protective coating is a third thing again, applied after '
          + 'correction and priced on how long it is meant to last.' },
      { h: 'What is at the kerb',
        p: 'A mobile detailer brings water and power or works without them. A '
          + 'shaded flat space near an outdoor tap is the easy case; a car in '
          + 'full sun dries chemicals onto the paint before they can be rinsed, '
          + 'and a car on a narrow street may not have room for the van and the '
          + 'work at the same time.' },
    ],
    diy: {
      yourself: 'A maintenance wash is genuinely a job for a Saturday morning, '
        + 'and two buckets, a grit guard and a soft mitt will get most of the '
        + 'way there. The risk is not the cost, it is the swirl marks a '
        + 'sponge and a single bucket grind into the clear coat, which then '
        + 'cost machine time to take out again.',
      pro: 'The cases worth paying for are the ones where the tools are the '
        + 'point: a machine polisher and the experience to know how much clear '
        + 'coat is there, a hot water extractor for upholstery, or an ozone or '
        + 'enzyme treatment for a smell. Those are not hire-shop purchases for '
        + 'one car.',
    },
    saving: [
      'Book the interior and the exterior as one visit rather than two. The '
        + 'setting up, the water and the travel happen once either way.',
      'Clear the car out before they arrive. Time spent moving your things off '
        + 'the seats is time inside the block you booked.',
      'Ask for a wash and a wax rather than a correction if the paint is sound. '
        + 'Polishing is for removing damage, and there is no point paying for '
        + 'it if there is none.',
      'Somewhere shaded and flat, near a tap, makes the job quicker and the '
        + 'finish better at the same time.',
    ],
  },

  'junk removal': {
    factors: [
      { h: 'How much of the truck it fills',
        p: 'This is the main thing, almost everywhere. Junk removal is priced '
          + 'by volume — a quarter load, a half load, a full load — because '
          + 'volume is what decides how many trips are made and how much space '
          + 'the day is worth. Bulk beats weight for most household clearances.' },
      { h: 'What the tip charges to take it',
        p: 'The disposal fee is a real cost passed on, and it varies by what is '
          + 'in the load. Clean green waste, rubble and mixed household waste '
          + 'are charged at different rates by the facility, and a load that '
          + 'has to be sorted before it can be tipped costs more than one that '
          + 'can be tipped as it stands.' },
      { h: 'Items that cannot go in the general load',
        p: 'Mattresses, tyres, paint and solvents, fridges and freezers with '
          + 'refrigerant in them, televisions and other electronics, and '
          + 'anything with a battery are handled and disposed of separately, '
          + 'often at a fixed fee per item, because the law says where they can '
          + 'go. Naming these when you book is what stops the price moving on '
          + 'the day.' },
      { h: 'Weight, once it stops being household waste',
        p: 'Soil, rubble, concrete, roofing and plasterboard are heavy enough '
          + 'to hit the vehicle’s weight limit long before they fill it, so '
          + 'they are usually treated as their own kind of load rather than as '
          + 'a fraction of a general one.' },
      { h: 'How far it has to be carried',
        p: 'A pile already in the driveway and the same pile in a third-floor '
          + 'flat with no lift are the same volume and very different amounts of '
          + 'work. Stairs, long carries, narrow gates and awkward parking are '
          + 'the things that turn an hour into three.' },
      { h: 'Whether anything has to come apart first',
        p: 'A shed, a bed frame, a wardrobe or decking has to be dismantled '
          + 'before it can be loaded, and that is labour on top of the removal '
          + 'rather than part of it.' },
    ],
    diy: {
      yourself: 'A car boot of cardboard is a trip to the recycling centre, and '
        + 'hiring a van for an afternoon can be the cheaper answer for a single '
        + 'bulky item you can lift safely with a second pair of hands. Check '
        + 'first what your local facility accepts and whether it charges for '
        + 'trade-type waste.',
      pro: 'The case for booking someone is heavy, awkward or regulated waste — '
        + 'anything you would be lifting down stairs, anything with refrigerant '
        + 'in it, and anything a tip will refuse from a private vehicle. They '
        + 'are also carrying the disposal duty for it, which matters: waste '
        + 'that is fly-tipped stays your responsibility in most places.',
    },
    saving: [
      'Separate the load before they arrive. Metal, clean green waste and '
        + 'cardboard are often free or cheap to dispose of, and pulling them '
        + 'out shrinks the part that is charged for.',
      'Move what you safely can to the ground floor or the driveway. Carrying '
        + 'distance is one of the biggest single costs in this trade.',
      'Say what is in the load when you book, including the mattress and the '
        + 'fridge. A surprise at the door is the most expensive kind.',
      'Sell, donate or list the things that are still usable first — a smaller '
        + 'load is a cheaper load, and furniture charities will often collect.',
    ],
  },

  'mobile locksmith': {
    factors: [
      { h: 'What the job actually is',
        p: 'Opening a door you are locked out of, changing the pins in a lock '
          + 'so the old keys stop working, and fitting an entirely new lock are '
          + 'three different jobs. A lockout is usually the quickest, a rekey '
          + 'needs the cylinder and the right pinning kit, and a replacement '
          + 'means new hardware as well as the labour to fit it.' },
      { h: 'The kind of lock on the door',
        p: 'A standard pin tumbler is routine. A high-security or restricted '
          + 'keyway cylinder, a mortice deadlock to insurance specification, a '
          + 'multipoint mechanism on a uPVC door, or a smart lock with its own '
          + 'firmware each need different tooling and different time, and a '
          + 'restricted keyway means blanks that only certain locksmiths can '
          + 'even buy.' },
      { h: 'Whether it is a vehicle',
        p: 'Car work is a separate discipline. A modern key is a transponder or '
          + 'a proximity fob that has to be cut and then programmed to the car, '
          + 'which needs diagnostic equipment and, on many makes, access to the '
          + 'manufacturer’s key data. Losing every key to a car is a much '
          + 'bigger job than losing one of two.' },
      { h: 'How many locks, and whether they should share a key',
        p: 'Doing several at once is less than doing them one at a time, '
          + 'because the visit and the setting up happen once. Keying several '
          + 'cylinders alike so one key opens all of them is a common request '
          + 'and it changes what parts are needed.' },
      { h: 'When you call',
        p: 'Night, weekend and holiday call-outs are priced differently from a '
          + 'planned weekday appointment nearly everywhere in the trade. An '
          + 'emergency is being paid for as an emergency.' },
      { h: 'Whether the hardware is included',
        p: 'The labour and the lock itself are often quoted separately, because '
          + 'the difference between a basic cylinder and a certified one is '
          + 'entirely in the part. Ask which you are being quoted.' },
    ],
    saving: [
      'If you are locked out and there is a spare key somewhere reachable, '
        + 'fetching it is almost always cheaper than any call-out.',
      'A rekey rather than a replacement is the answer when the lock is sound '
        + 'and you only need the old keys to stop working — after a house move, '
        + 'or a lost set.',
      'Booking a planned appointment rather than calling at midnight is the '
        + 'single largest saving available in this trade.',
      'Do all the doors in one visit if more than one needs work, and ask '
        + 'whether they can be keyed alike while they are at it.',
    ],
  },

  'mobile oil change and mechanics': {
    factors: [
      { h: 'What the engine takes, and how much of it',
        p: 'Oil is specified by the manufacturer, not chosen by preference, and '
          + 'a modern low-viscosity full synthetic to a particular approval is a '
          + 'different product from a conventional oil. Capacity matters as much '
          + 'as grade: a small petrol engine and a large diesel can differ by '
          + 'several litres per service.' },
      { h: 'Which filters are on the list',
        p: 'An oil filter is part of any oil change. Air, cabin and fuel '
          + 'filters are usually on their own intervals, so a service that '
          + 'happens to fall on all of them is a longer job with more parts in '
          + 'it than one that does not.' },
      { h: 'Diagnosis against repair',
        p: 'Finding out what is wrong and fixing it are separate pieces of '
          + 'work. A fault code is a starting point rather than an answer, and '
          + 'the time to trace an intermittent electrical fault has very little '
          + 'to do with the cost of the part that eventually fixes it.' },
      { h: 'The parts themselves',
        p: 'On most repairs the part is a large share of the bill, and there is '
          + 'a real spread between manufacturer-branded, original-equipment and '
          + 'aftermarket components. Which one is being quoted is a fair '
          + 'question to ask before the work starts.' },
      { h: 'Where the car is standing',
        p: 'Mobile work happens on the ground, on jacks or ramps, in whatever '
          + 'space the car is in. A level driveway with room to work is '
          + 'straightforward; a sloped street, a tight underground car park with '
          + 'a low ceiling, or a permit bay a van cannot stop in are all reasons '
          + 'a job takes longer or cannot be done at the kerb at all.' },
      { h: 'What has to happen to the old oil',
        p: 'Used oil and filters are controlled waste and have to be taken away '
          + 'and disposed of properly. That is part of what a mobile service is '
          + 'carrying that a driveway job is not.' },
    ],
    diy: {
      yourself: 'An oil and filter change on an older car with an accessible '
        + 'sump plug is a genuinely approachable job, and the parts are the '
        + 'bulk of the cost. You need somewhere level, a way to lift the car '
        + 'safely — ramps or axle stands, never a jack alone — a drain pan, and '
        + 'a plan for taking the old oil to a facility that will accept it.',
      pro: 'Anything holding the car up, stopping it or steering it is the '
        + 'wrong place to learn. Brakes, suspension, cambelts and anything '
        + 'needing a torque figure you cannot verify are worth paying for, and '
        + 'so is any car under a warranty that requires a documented service '
        + 'history.',
    },
    saving: [
      'Group the jobs. Most of a mobile visit is arriving and setting up, so a '
        + 'service and the wiper blades and the air filter together cost less '
        + 'than three visits.',
      'Ask what grade of oil is being used and check it against the handbook. '
        + 'Paying for a specification the engine does not need is money spent '
        + 'on nothing.',
      'Ask whether an aftermarket part is suitable where one exists. Often it '
        + 'is; sometimes it is not, and that is worth hearing before rather '
        + 'than after.',
      'Fix a noise while it is a noise. Almost every expensive mechanical '
        + 'repair was a cheap one a few months earlier.',
    ],
  },

  'mobile pressure washing': {
    factors: [
      { h: 'How much surface there is',
        p: 'This is an area job before it is anything else. A path, a driveway, '
          + 'a patio and a whole frontage are priced by how much ground has to '
          + 'be passed over, and the machine only cleans as fast as it cleans.' },
      { h: 'What the surface is made of',
        p: 'Concrete and block paving will take real pressure. Timber decking, '
          + 'render, painted brick and roof tiles will not — those are soft '
          + 'washed at low pressure with a chemical doing the work instead, '
          + 'which is a slower and more careful process. Using the wrong one is '
          + 'how a patio ends up striped and a roof ends up leaking.' },
      { h: 'What is growing or spilled on it',
        p: 'Loose dirt rinses off. Algae, lichen and moss need a biocide and '
          + 'time to work, sometimes with a return visit; engine oil, paint and '
          + 'rust need a specific degreaser or remover each, and some staining '
          + 'in porous stone never fully comes out.' },
      { h: 'Whether it is sealed afterwards',
        p: 'Re-sanding the joints in block paving and sealing the surface are '
          + 'separate pieces of work done after the cleaning, and they carry '
          + 'their own materials and their own drying time.' },
      { h: 'Water, power and where the run-off goes',
        p: 'The machine needs a supply and somewhere for the water to go. A '
          + 'site with no outside tap means bringing a tank; run-off carrying '
          + 'chemicals, oil or paint may not be allowed into a surface drain at '
          + 'all, and containing and collecting it is extra work.' },
      { h: 'Getting to it',
        p: 'Height and access decide as much as area. A ground-floor wall and '
          + 'the same wall two storeys up are different jobs, and hoses only '
          + 'reach so far from where the van can park.' },
    ],
    diy: {
      yourself: 'A domestic electric washer will handle a path, a patio and a '
        + 'car, and hiring a larger one for a weekend is a real option for a '
        + 'driveway. Work in overlapping passes at a steady distance, and keep '
        + 'well away from render, timber, window seals and anything painted.',
      pro: 'Roofs, render, anything above head height and anything with a '
        + 'biological growth that needs treating rather than blasting are the '
        + 'cases to hand over. So is any surface where the run-off has to be '
        + 'contained. Most of the damage this trade repairs was done by '
        + 'somebody with a domestic machine and too much confidence.',
    },
    saving: [
      'Clear the area first — furniture, pots, cars and bins. It is all time '
        + 'inside the block you booked.',
      'Do the whole of a surface at once rather than in pieces. Half a clean '
        + 'driveway looks worse than a dirty one, and the setting up is the '
        + 'same either way.',
      'Ask whether treating growth and returning is cheaper than trying to '
        + 'blast it off in one go. For lichen and moss it usually is, and it '
        + 'does less harm to the surface.',
      'An outside tap and a nearby socket save the job the time of working '
        + 'around not having them.',
    ],
  },

  'mobile pet grooming': {
    factors: [
      { h: 'The size of the animal',
        p: 'Everything scales with it: the bath, the drying, the brushing and '
          + 'the amount of coat to work through. A toy breed and a large working '
          + 'dog are not the same appointment at any stage of it.' },
      { h: 'The coat, and the state it is in',
        p: 'A short single coat is quick. A double coat sheds in volume and '
          + 'needs proper de-shedding rather than clipping; a curly or wool coat '
          + 'mats close to the skin and has to be worked out strand by strand. '
          + 'Severe matting is the single biggest cost in this trade, and it is '
          + 'the reason a coat that has been left is sometimes clipped short on '
          + 'welfare grounds rather than saved.' },
      { h: 'What the groom actually is',
        p: 'A bath, brush and tidy is a different appointment from a full '
          + 'breed-standard scissored trim, and hand-stripping a wire coat is '
          + 'different again — that is hours of pulling coat out by hand rather '
          + 'than minutes with clippers.' },
      { h: 'How the animal handles being groomed',
        p: 'A dog that stands calmly and a dog that is frightened of the dryer '
          + 'or the nail clippers take very different amounts of time, and the '
          + 'second may need two people or several short sessions. This is about '
          + 'the animal rather than about the owner, and a groomer who slows '
          + 'down for a nervous dog is doing the job properly.' },
      { h: 'What is added on',
        p: 'Nails, ears, teeth, anal glands, de-shedding treatments and flea '
          + 'baths are usually separate items rather than part of a standard '
          + 'groom, and a flea infestation means the van has to be cleaned down '
          + 'afterwards before anything else can go in it.' },
      { h: 'How often it happens',
        p: 'A coat kept on a regular schedule is quicker to work on every time. '
          + 'The appointment after a long gap is the expensive one, because it '
          + 'is undoing the gap as well as grooming.' },
    ],
    saving: [
      'Brush between appointments, right down to the skin rather than over the '
        + 'top. Matting is what makes a groom long, and it forms underneath.',
      'Keep to a regular interval rather than waiting until the coat is a '
        + 'problem. Shorter, more frequent appointments usually cost less over '
        + 'a year than rescuing a coat twice.',
      'Ask for a shorter practical trim rather than a full breed cut if the '
        + 'look is not the point. It is less scissor time.',
      'Get a puppy used to being handled — paws, ears, the noise of a dryer — '
        + 'long before the first groom. Every minute of that is time not spent '
        + 'at the appointment.',
    ],
  },

  'phone and tablet repair': {
    factors: [
      { h: 'The part, more than the labour',
        p: 'On most phone repairs the component is the majority of the bill. A '
          + 'screen assembly for a current flagship costs a multiple of one for '
          + 'a mid-range handset three years old, and the fitting time is much '
          + 'the same for both.' },
      { h: 'Which screen is being fitted',
        p: 'There is a real spread here and it is worth asking about. An '
          + 'original manufacturer part, a high-quality aftermarket panel and a '
          + 'cheap copy differ in colour, brightness, touch response and '
          + 'lifespan. On phones with an OLED panel the gap is widest, because '
          + 'the cheap alternative is usually an LCD standing in for one.' },
      { h: 'What is broken',
        p: 'A battery, a charging port, a rear glass, a camera and a screen are '
          + 'all different jobs with different parts. Board-level work — a fault '
          + 'in the logic board itself — is a different discipline again, done '
          + 'under a microscope, and not every repairer offers it.' },
      { h: 'How the device is built',
        p: 'Some models are designed to open. Others are glued front and back, '
          + 'need heat and suction to separate, and put the battery where it can '
          + 'be punctured on the way in. Waterproofed models need their seals '
          + 'replaced on reassembly if the rating is to mean anything after.' },
      { h: 'Water damage',
        p: 'This is the one that cannot be quoted honestly in advance. It needs '
          + 'opening, cleaning and testing before anybody knows which parts have '
          + 'corroded, and it is the case where a repair may turn out not to be '
          + 'worth doing.' },
      { h: 'Parts that are paired to the phone',
        p: 'On several manufacturers the fingerprint reader, the face sensor or '
          + 'the battery is matched to the board, so a replacement may lose that '
          + 'feature or raise a warning even when correctly fitted. That is the '
          + 'manufacturer’s design rather than the repairer’s doing, but it '
          + 'should be said before the work, not after.' },
    ],
    saving: [
      'Back the device up before the appointment. A repair that goes wrong on '
        + 'a backed-up phone costs a phone; on an unbacked-up one it costs '
        + 'everything on it.',
      'Ask what grade of screen is being quoted, and what the difference in '
        + 'price buys. Sometimes the cheaper panel is the sensible answer and '
        + 'sometimes it is not.',
      'Get the battery and the screen done together if both are due. The device '
        + 'only has to be opened once.',
      'Check whether the device is still under warranty or a manufacturer '
        + 'service programme first — an independent repair usually ends the '
        + 'former.',
    ],
  },

  'auto glass repair': {
    factors: [
      { h: 'Repair or replace',
        p: 'A small chip out of the driver’s line of sight can often be '
          + 'filled with resin in a short appointment. A crack that has run, or '
          + 'damage in the swept area of the wipers, means the whole screen '
          + 'comes out — an entirely different job with a large part in it.' },
      { h: 'Which piece of glass',
        p: 'A windscreen is laminated and bonded into the body. Side and rear '
          + 'glass is usually toughened, breaks into fragments, and is fitted '
          + 'differently — often with a door card to come off first.' },
      { h: 'What the screen has built into it',
        p: 'Modern windscreens carry rain sensors, heating elements, aerials, '
          + 'heads-up display film and the camera for the driver assistance '
          + 'systems. Each of those has to be matched, and a screen with several '
          + 'of them is a more expensive piece of glass.' },
      { h: 'Recalibration afterwards',
        p: 'If the car has a forward-facing camera behind the screen, moving '
          + 'that screen means the camera has to be recalibrated before the lane '
          + 'and braking systems can be trusted. It is a separate procedure with '
          + 'its own equipment, and on some vehicles it needs a level indoor '
          + 'space with a target board rather than a driveway.' },
      { h: 'How long the adhesive needs',
        p: 'A bonded screen has a safe drive-away time while the urethane '
          + 'cures, and that depends on the product, the temperature and the '
          + 'humidity. It is not a delay that can be shortened by asking.' },
    ],
    saving: [
      'Get a chip looked at early. Filling one is a fraction of replacing the '
        + 'screen it becomes after a cold night or a speed bump.',
      'Check your motor policy before booking. Glass is very often covered '
        + 'separately from the main excess, and sometimes at no cost for a '
        + 'repair.',
      'Ask whether the replacement glass carries the same sensors and heating '
        + 'as the one coming out, and whether recalibration is in the price or '
        + 'quoted on top.',
    ],
  },

  'mobile tyre fitting': {
    factors: [
      { h: 'The size and rating on the sidewall',
        p: 'Width, profile, rim diameter, load index and speed rating are all '
          + 'specified for the car rather than chosen, and a large low-profile '
          + 'tyre for a fast car is a different product entirely from a small '
          + 'one for a city car.' },
      { h: 'What kind of tyre it is',
        p: 'Budget, mid-range and premium brands sit at genuinely different '
          + 'prices, as do summer, winter and all-season compounds. A run-flat '
          + 'has a reinforced sidewall, costs more, and is harder to get on and '
          + 'off the rim.' },
      { h: 'What comes with the fitting',
        p: 'Balancing is part of doing the job properly. A new valve is cheap '
          + 'on an ordinary wheel and not cheap on one with a tyre pressure '
          + 'sensor in it, and that sensor may need to be reprogrammed to the '
          + 'car afterwards.' },
      { h: 'How many at once',
        p: 'Tyres are usually replaced in pairs across an axle so the grip '
          + 'matches side to side, and a set of four in one visit is one lot of '
          + 'travelling and setting up rather than two.' },
      { h: 'Disposal of the old ones',
        p: 'Scrap tyres are controlled waste with a per-tyre charge to dispose '
          + 'of. It is small and it is real, and it should be on the quote.' },
      { h: 'Repair, where a repair is allowed',
        p: 'A puncture in the central tread area, within limits on size, can be '
          + 'plugged and patched from the inside. Damage to the sidewall or the '
          + 'shoulder cannot be repaired safely at all, and a tyre that has been '
          + 'run flat is usually finished regardless of where the hole is.' },
    ],
    saving: [
      'Replace in pairs rather than all four when only one axle is worn, if the '
        + 'other axle still has real tread on it.',
      'Ask whether a repair is possible before agreeing to a replacement. On a '
        + 'central tread puncture it often is.',
      'Check pressures monthly. Underinflated tyres wear out at the edges and '
        + 'cost fuel the whole time they are doing it.',
    ],
  },

  'house cleaning': {
    factors: [
      { h: 'How much floor and how many rooms',
        p: 'Size is the base of every quote in this trade, usually counted in '
          + 'bedrooms and bathrooms because those are what take the time. '
          + 'Bathrooms and kitchens are slower per square metre than anywhere '
          + 'else in a house.' },
      { h: 'The first clean against the ones after it',
        p: 'An initial deep clean on a house that has not been cleaned '
          + 'professionally before is longer than every visit that follows it, '
          + 'and is generally priced as its own job. Regular visits are shorter '
          + 'because they are maintaining rather than catching up.' },
      { h: 'How often',
        p: 'Weekly, fortnightly and monthly visits are different amounts of '
          + 'work each time, because the dirt accumulates in between. Monthly '
          + 'is not four times cheaper than weekly.' },
      { h: 'What is included',
        p: 'Inside the oven, inside the fridge, inside the windows, laundry, '
          + 'ironing, changing beds and skirting boards are commonly extras '
          + 'rather than part of a standard clean. An end-of-tenancy clean is a '
          + 'different specification again, aimed at an inventory check.' },
      { h: 'Whether products and equipment are brought',
        p: 'Some cleaners bring everything, some use what is in the house, and '
          + 'that is reflected in the price. Specific requirements — fragrance '
          + 'free, pet safe, a particular finish on stone — are worth saying at '
          + 'the booking.' },
      { h: 'What is in the way',
        p: 'Clutter is the difference between cleaning a surface and clearing a '
          + 'surface and then cleaning it. Pets, and the hair they leave on soft '
          + 'furnishings, add time to every visit.' },
    ],
    saving: [
      'Tidy before rather than clean before. Clear surfaces and floors are what '
        + 'make a booked hour go further; scrubbing first is paying twice.',
      'Book a regular slot instead of occasional deep cleans. Maintaining is '
        + 'cheaper than recovering, every time.',
      'Pick the rooms that matter if the budget is fixed. A shorter visit that '
        + 'does the kitchen and bathrooms properly beats a rushed pass at the '
        + 'whole house.',
    ],
  },

  'carpet cleaning': {
    factors: [
      { h: 'How much there is to clean',
        p: 'Priced by room or by area nearly everywhere. Stairs are usually '
          + 'counted separately and are slower than their area suggests, because '
          + 'every tread is an edge.' },
      { h: 'What the carpet is made of',
        p: 'Synthetic fibres take hot water and detergent well. Wool is more '
          + 'sensitive to heat and alkalinity, and natural fibres such as sisal '
          + 'or jute can be ruined by the amount of water that would be routine '
          + 'on nylon.' },
      { h: 'How dirty, and with what',
        p: 'General traffic soiling comes out with the standard process. Pet '
          + 'accidents, red wine, ink, grease and dye transfer each need their '
          + 'own treatment and their own dwell time, and odour from urine has to '
          + 'be treated in the underlay rather than at the surface if it is '
          + 'actually to go.' },
      { h: 'Which method',
        p: 'Hot water extraction cleans deepest and leaves the carpet damp for '
          + 'hours. Low-moisture and encapsulation methods dry in a fraction of '
          + 'the time and are gentler, but lift less. Which is right depends on '
          + 'the carpet and on how soon the room is needed.' },
      { h: 'What has to be moved',
        p: 'Furniture moved and put back is labour. A room cleared before they '
          + 'arrive is a room that gets cleaned rather than emptied.' },
    ],
    saving: [
      'Clear the rooms yourself. Moving furniture is often quoted as an extra '
        + 'and always takes time out of the visit.',
      'Do several rooms in one appointment. Setting up the machine and running '
        + 'the hoses happens once.',
      'Deal with a spill while it is wet, by blotting rather than rubbing. Most '
        + 'permanent stains were fresh ones once.',
      'Vacuum thoroughly beforehand — dry soil removed first is dry soil that '
        + 'does not turn to mud in the machine.',
    ],
  },

  'window cleaning': {
    factors: [
      { h: 'How many panes, not how many windows',
        p: 'A Georgian-style window with twelve small panes takes far longer '
          + 'than a single large pane of the same area, because the time is in '
          + 'the edges and the bars.' },
      { h: 'How high, and how it is reached',
        p: 'Ground-floor glass is straightforward. Anything above it is reached '
          + 'from a pole-fed system, a ladder or an access platform, and the '
          + 'higher and more awkward it is the more the job costs and the more '
          + 'equipment turns up to do it.' },
      { h: 'Inside as well as outside',
        p: 'Insides mean access to the rooms, moving things off sills, and '
          + 'working around furniture. It is a separate part of the job and it '
          + 'is generally the slower half.' },
      { h: 'Frames, sills and screens',
        p: 'A pure glass clean and a full clean including frames, sills and '
          + 'screens are different specifications. Screens have to come out, be '
          + 'washed and go back.' },
      { h: 'How often',
        p: 'Regular visits are quicker each time. A first clean after years, or '
          + 'after building work, is closer to a restoration — mortar splash, '
          + 'paint and hard water scale need scraping or chemical treatment '
          + 'rather than washing.' },
    ],
    saving: [
      'Take a regular interval rather than one-off visits. It is the cheapest '
        + 'way to buy each clean.',
      'Clear the sills and unlock the gate before they arrive.',
      'Ask for outsides only if the insides are not the problem. On most houses '
        + 'the outside is where the dirt is.',
    ],
  },

  'gutter cleaning': {
    factors: [
      { h: 'How much guttering there is',
        p: 'Measured in the run of gutter around the building. A long, simple '
          + 'rectangular house has less than a shorter one with several wings, '
          + 'bays and extensions, because each of those adds corners and '
          + 'outlets.' },
      { h: 'How high and how reachable',
        p: 'A single-storey run is quick work. Two and three storeys need '
          + 'longer poles, taller ladders or a platform, and a conservatory '
          + 'roof, a flowerbed or a neighbour’s fence under the run is a '
          + 'problem to solve before any clearing starts.' },
      { h: 'The pitch and shape of the roof',
        p: 'A steep roof sheds more into the gutter and is harder to work '
          + 'beside. Valleys, dormers and hidden or parapet gutters take much '
          + 'longer than an ordinary eaves run.' },
      { h: 'What is in them',
        p: 'Leaves clear easily. Compacted silt, moss washed off the tiles and '
          + 'saplings that have taken root are a different job, and a blocked '
          + 'downpipe has to be rodded or flushed rather than scooped.' },
      { h: 'Whether guards are involved',
        p: 'Existing gutter guards have to come off and go back to clear '
          + 'underneath them. Fitting new ones is separate work with materials.' },
      { h: 'How long since the last time',
        p: 'Annual clearing is maintenance. A gutter left for years may need '
          + 'brackets or joints repaired once the weight comes out of it, and '
          + 'that is repair rather than cleaning.' },
    ],
    saving: [
      'Do it before the season it is needed for rather than after a blockage '
        + 'has already put water down a wall. Damp from an overflowing gutter '
        + 'costs many times the clearing.',
      'Clear access underneath first — bins, furniture, pots and cars.',
      'Ask for the downpipes to be checked while they are there. A clear gutter '
        + 'into a blocked pipe is still an overflowing gutter.',
    ],
  },

  'trash can cleaning': {
    factors: [
      { h: 'How many bins',
        p: 'Priced per bin almost everywhere, with the second and third costing '
          + 'less than the first because the visit only happens once.' },
      { h: 'The size of them',
        p: 'A household wheelie bin and a large commercial container are '
          + 'different amounts of water, time and space in the machine.' },
      { h: 'How often',
        p: 'A regular cleaning on the day after collection is quick, because '
          + 'the bin is empty and it has only had a fortnight to get dirty. A '
          + 'one-off on a bin that has never been cleaned takes real scrubbing.' },
      { h: 'Timing against the collection',
        p: 'The bin has to be empty. A visit that has to work around a full bin '
          + 'is a wasted visit, which is why this trade almost always works to '
          + 'the collection calendar.' },
    ],
    saving: [
      'Book the round that comes the day after your collection. An empty bin is '
        + 'the whole job.',
      'Have all the bins done in one visit rather than one at a time.',
      'Bag waste before it goes in. Most of what makes a bin need cleaning is '
        + 'what leaked out of a bag.',
    ],
  },

  'dryer vent cleaning': {
    factors: [
      { h: 'How long the duct is and where it goes',
        p: 'A dryer against an outside wall with a short straight run is the '
          + 'easy case. A long run through a ceiling void or up to a roof '
          + 'terminal needs different rods and much more time.' },
      { h: 'How many bends',
        p: 'Lint collects at every elbow. A duct with several turns in it holds '
          + 'more, is harder to get a brush through, and takes longer to prove '
          + 'clear.' },
      { h: 'How much has built up',
        p: 'A vent cleared last year is maintenance. One that has never been '
          + 'cleared may be substantially blocked, which is both the reason the '
          + 'machine takes three cycles to dry a load and the reason this is a '
          + 'fire-safety job rather than a housekeeping one.' },
      { h: 'Getting to the machine and the terminal',
        p: 'A dryer stacked, built in under a worktop or in a cupboard has to '
          + 'come out and go back. An outside terminal at height needs access '
          + 'equipment.' },
    ],
    saving: [
      'Clean the lint filter after every load. It does not replace clearing the '
        + 'duct, but it is what decides how fast the duct fills.',
      'Have it done at the same visit as anything else booked at the house, so '
        + 'the travelling happens once.',
      'Do it before the dryer starts taking two cycles rather than after. The '
        + 'wasted electricity adds up faster than the appointment costs.',
    ],
  },

  'appliance repair': {
    factors: [
      { h: 'Diagnosis, then repair',
        p: 'Most of this trade charges to come out and find the fault, and that '
          + 'charge is often set against the repair if you go ahead. It is a '
          + 'real piece of work: the symptom rarely names the component.' },
      { h: 'Which part has failed',
        p: 'A door seal, a belt or a pump is one kind of job. A control board, '
          + 'a motor or a compressor is another, and on some machines the part '
          + 'alone approaches what a replacement appliance costs.' },
      { h: 'Whether the part still exists',
        p: 'Manufacturers support parts for a limited number of years. An '
          + 'appliance past that point may need a used or pattern part, or may '
          + 'not be repairable at any price, and that is worth knowing before '
          + 'the diagnosis is paid for.' },
      { h: 'Sealed system work',
        p: 'Anything involving refrigerant in a fridge or freezer needs '
          + 'certification to handle the gas and is a specialist job rather than '
          + 'a general one.' },
      { h: 'Where the machine is',
        p: 'A freestanding machine is pulled out and worked on. An integrated '
          + 'one is unbolted from the cabinetry first, and an American-style '
          + 'fridge in a tight alcove may need two people just to reach the '
          + 'back of it.' },
    ],
    saving: [
      'Ask for the diagnosis fee and whether it comes off the repair before '
        + 'booking. It is a normal question and it should get a straight '
        + 'answer.',
      'Ask what the part costs against what the appliance is worth. A good '
        + 'repairer will tell you when a machine is not worth fixing.',
      'Check the warranty and the manufacturer’s own repair scheme first.',
      'Clean the filters and the condenser coils. A surprising share of '
        + 'call-outs are machines that were never blocked, only choked.',
    ],
  },

  'pool service': {
    factors: [
      { h: 'How much water there is',
        p: 'Chemical demand scales with volume, so a small plunge pool and a '
          + 'long lap pool cost differently to balance every single visit.' },
      { h: 'Regular service against a rescue',
        p: 'A weekly or fortnightly visit is testing, dosing, brushing and '
          + 'emptying baskets. Bringing a green pool back is a different job '
          + 'with days of filtration, heavy dosing and often a filter clean or '
          + 'a partial drain in it.' },
      { h: 'What is in the chemicals',
        p: 'Chlorine, acid, stabiliser and algaecide are consumed rather than '
          + 'used, and demand rises with heat, sunlight, rain and how many '
          + 'people are swimming. A hot week costs more than a cool one.' },
      { h: 'The equipment',
        p: 'Pump, filter, heater, chlorinator and automatic cleaner all have '
          + 'their own servicing, and a filter that needs backwashing or '
          + 'replacing is separate from the water chemistry.' },
      { h: 'What is around the pool',
        p: 'Overhanging trees, wind-blown dust and no cover all mean more '
          + 'skimming, more vacuuming and more chemical every visit.' },
    ],
    saving: [
      'Use a cover. It cuts evaporation, chemical loss and the amount of debris '
        + 'that has to be taken out, and it is the single most effective saving '
        + 'available here.',
      'Keep the visits regular. A pool that has gone green costs many times '
        + 'what keeping it clear would have.',
      'Empty the skimmer baskets between visits. It takes a minute and it keeps '
        + 'the pump working properly.',
    ],
  },

  'pest control': {
    factors: [
      { h: 'Which pest',
        p: 'This decides everything else. Ants, wasps, rodents, cockroaches, '
          + 'fleas, bed bugs and termites need different products, different '
          + 'methods and very different amounts of time, and bed bugs and '
          + 'termites are at the demanding end of that list by a distance.' },
      { h: 'One visit or a course',
        p: 'A wasp nest is usually one treatment. Rodents, cockroaches and bed '
          + 'bugs are a programme — an initial treatment and one or more '
          + 'follow-ups timed to the life cycle, because the eggs are not '
          + 'killed by the first pass.' },
      { h: 'How far it has spread',
        p: 'A problem caught in one room is smaller than one that has reached '
          + 'the cavity walls, the loft or a neighbouring property. Extent is '
          + 'found by inspection, which is why a firm price often comes after a '
          + 'look rather than over the phone.' },
      { h: 'The size and construction of the building',
        p: 'More rooms, more voids and more entry points mean more to treat and '
          + 'more to proof. Older buildings tend to have more ways in.' },
      { h: 'Proofing as well as treating',
        p: 'Killing what is there and sealing the way it got in are two pieces '
          + 'of work. Without the second the first is temporary, and proofing is '
          + 'building work as much as pest work.' },
      { h: 'What has to happen around the treatment',
        p: 'Some treatments need the property emptied for a period, laundry '
          + 'washed at temperature, or furniture moved and rooms prepared. That '
          + 'is your time rather than theirs, but it is part of the cost of the '
          + 'job.' },
    ],
    saving: [
      'Act early. Almost every pest problem is cheaper when it is smaller, and '
        + 'this is the trade where that is most sharply true.',
      'Do the preparation they ask for properly. A treatment that fails because '
        + 'the room was not cleared has to be paid for twice.',
      'Fix the way in — the gap under the door, the food left out, the '
        + 'unsealed bin. Treatment without that is a subscription.',
    ],
  },

  'handyman and repair services': {
    factors: [
      { h: 'How the time is sold',
        p: 'Small jobs are usually an hourly or half-day rate with a minimum, '
          + 'because half an hour of work still costs a whole journey. Larger '
          + 'or well-defined jobs are more often quoted as a fixed price.' },
      { h: 'How many jobs, and whether they are near each other',
        p: 'A list done in one visit is far better value than the same list '
          + 'done one item at a time. Tools come out once and the travelling '
          + 'happens once.' },
      { h: 'Materials',
        p: 'Fixings, timber, sealant, paint and fittings are on top of the '
          + 'labour, and whether you buy them or they do changes both the price '
          + 'and who carries the trip to fetch them.' },
      { h: 'What the job really is once it is opened up',
        p: 'The honest part of this trade: a shelf into a stud wall and a shelf '
          + 'into crumbling plaster are the same request and different jobs. '
          + 'Older buildings, hidden damp and previous bad repairs are the usual '
          + 'reasons an hour becomes three.' },
      { h: 'Where it is in the building',
        p: 'Working at height, in a loft, under a floor or in a space that has '
          + 'to be emptied first is slower than working at bench height in an '
          + 'open room.' },
      { h: 'Where the trade’s edge is',
        p: 'Some work is not a handyman job in most places regardless of skill '
          + '— gas, and notifiable electrical or structural work — and needs the '
          + 'relevant registered trade instead.' },
    ],
    saving: [
      'Save the small jobs up and do them in one visit. This is the biggest '
        + 'saving in the trade and it is entirely in your control.',
      'Buy the materials yourself where you know exactly what is needed.',
      'Clear the working area and move the furniture before they arrive.',
      'Describe the job precisely when booking, with a photograph if you can. '
        + 'The right tools in the van the first time saves a second visit.',
    ],
  },

  'landscaping and gardening': {
    factors: [
      { h: 'How big the plot is',
        p: 'The base of any quote, whether the work is mowing, planting or '
          + 'clearing.' },
      { h: 'How overgrown it is',
        p: 'Maintaining a garden that is already in order is routine. Bringing '
          + 'back one that has been left for a season or two is clearance work, '
          + 'and clearance is much slower than upkeep and produces far more '
          + 'waste.' },
      { h: 'What has to be taken away',
        p: 'Green waste is charged to dispose of, and a full trailer of '
          + 'brambles and cuttings is a real cost on top of the labour. A garden '
          + 'with room for a compost heap is a cheaper garden.' },
      { h: 'One visit or a season',
        p: 'A regular round is priced per visit at less than the same work done '
          + 'once, because each visit is shorter and the travel is planned into '
          + 'a route.' },
      { h: 'Which season it is',
        p: 'Growth is not spread evenly through the year, and neither is the '
          + 'demand for this trade. The same lawn takes more visits in June than '
          + 'in January.' },
      { h: 'Whether anything is being built or planted',
        p: 'Turfing, planting, edging, fencing and paving carry materials as '
          + 'well as labour, and materials are usually the larger half.' },
    ],
    saving: [
      'Take a regular visit rather than occasional rescues. Upkeep is cheaper '
        + 'than clearance every time.',
      'Compost what can be composted so it does not have to be carried away and '
        + 'paid for at a tip.',
      'Have the cutting and the tidying done at the same visit as anything '
        + 'else, rather than as separate trips.',
    ],
  },

  'tree and shrub trimming': {
    factors: [
      { h: 'How big the tree is',
        p: 'Height and spread decide the equipment, the number of people and '
          + 'the time. There is a large step between what can be reached from '
          + 'the ground or a ladder and what has to be climbed or reached from a '
          + 'platform.' },
      { h: 'What is underneath and around it',
        p: 'A tree in an open field can be dropped. The same tree over a roof, a '
          + 'greenhouse, a fence or a neighbour’s garden has to be taken down '
          + 'in sections and lowered on ropes, which is a different job '
          + 'entirely. Anything near an overhead power line is a job for the '
          + 'utility rather than a general trimmer.' },
      { h: 'What is being done to it',
        p: 'Crown lifting, thinning and reduction, a hedge cut, a full felling '
          + 'and stump grinding are separate pieces of work with separate '
          + 'prices, and the stump is very often quoted apart from the tree.' },
      { h: 'What happens to the arisings',
        p: 'Chipping on site, taking it away, or leaving it stacked as logs are '
          + 'three different amounts of work and cost. Removal is the dearest '
          + 'and it is the default assumption unless you say otherwise.' },
      { h: 'Access for the equipment',
        p: 'A chipper and a platform need to get in. A garden reachable only '
          + 'through the house or a narrow side gate means everything is carried '
          + 'by hand.' },
      { h: 'Whether the tree is protected',
        p: 'Trees under a preservation order or in a conservation area need '
          + 'permission before work starts, and that is a process with its own '
          + 'timescale.' },
    ],
    saving: [
      'Ask for the chippings and the logs to be left if you have a use for '
        + 'them. Not carrying the waste away is a genuine reduction.',
      'Have several trees or the whole hedge done in one visit — the climbing '
        + 'kit and the chipper only get set up once.',
      'Prune regularly rather than letting a tree get to the point of needing '
        + 'major surgery.',
      'Book outside the storm season if it is not urgent. Emergency work after '
        + 'a gale is the most expensive way to buy this trade.',
    ],
  },

  'bike repair service': {
    factors: [
      { h: 'Which level of service',
        p: 'Most workshops sell tiers — a safety check and adjustment, a fuller '
          + 'service with the drivetrain cleaned, and a strip-down with bearings '
          + 'serviced. The gap between them is hours, not minutes.' },
      { h: 'What has worn out',
        p: 'Chains, cassettes, chainrings, brake pads, cables and tyres are '
          + 'consumables and they wear together. A chain replaced on time is '
          + 'cheap; a chain left too long takes the cassette with it.' },
      { h: 'What the bike is',
        p: 'A hub-geared town bike, a road bike with hydraulic discs and '
          + 'internal cable routing, a full-suspension mountain bike and an '
          + 'electric bike each take different tools and different time. '
          + 'Internal routing in particular turns a cable change into a long '
          + 'job.' },
      { h: 'Hydraulic and electronic systems',
        p: 'Bleeding hydraulic brakes, servicing suspension, and diagnosing an '
          + 'electric bike’s motor, battery or wiring are specialist work '
          + 'beyond a general service.' },
      { h: 'Wheels',
        p: 'A true and tension is quick. A rebuild with new spokes or a new rim '
          + 'is an hour of skilled work plus parts, and a wheel damaged badly '
          + 'enough is often replaced instead.' },
    ],
    saving: [
      'Keep the chain clean and oiled. It is the cheapest maintenance there is '
        + 'and it protects the expensive parts around it.',
      'Replace the chain on wear rather than on failure — a chain checker costs '
        + 'less than one cassette.',
      'Have everything looked at in one visit rather than a squeak at a time.',
    ],
  },

  'mobile hair salon or barbershop': {
    factors: [
      { h: 'What the service is',
        p: 'A cut, a cut and finish, a colour, highlights, a full head of foils '
          + 'and a chemical straightening or perm are steps up in time from '
          + 'minutes to most of a day.' },
      { h: 'How much hair there is',
        p: 'Length, thickness and density decide how long any colouring or '
          + 'styling takes and how much product it consumes. Very long or very '
          + 'thick hair is commonly a separate price for exactly that reason.' },
      { h: 'What the hair has had done to it before',
        p: 'Colour correction — taking hair from a previous box dye, or from '
          + 'black back to blonde — is the most demanding work in the trade and '
          + 'is often several appointments rather than one, because doing it in '
          + 'one would damage the hair.' },
      { h: 'Product',
        p: 'Colour, developer, bond builders and treatments are consumed by the '
          + 'appointment, and a full head of a strong lightener uses a great '
          + 'deal more than a root touch-up.' },
      { h: 'Where it happens',
        p: 'A mobile appointment is one stylist, one client, and the setting up '
          + 'and clearing away at each address. Water and somewhere to rinse '
          + 'make a real difference to what can be offered.' },
      { h: 'How many people at one visit',
        p: 'A household done in one visit is one journey and one set-up, which '
          + 'is why family bookings are usually better value per head.' },
    ],
    saving: [
      'Book the whole household into one visit.',
      'Keep to a regular interval — a root touch-up is far less work than '
        + 'growing out four months and correcting it.',
      'Be honest about every colour the hair has had, including box dye. It '
        + 'changes the plan, and finding out mid-appointment is what turns one '
        + 'booking into three.',
    ],
  },

  'mobile spa and massage': {
    factors: [
      { h: 'How long the session is',
        p: 'Time is what is being sold, and the price follows it almost '
          + 'directly.' },
      { h: 'Which treatment',
        p: 'A relaxation massage, a deep tissue or sports massage, hot stones, '
          + 'and treatments needing their own products and equipment are '
          + 'different disciplines with different training behind them.' },
      { h: 'How many people',
        p: 'Two therapists for a couple, or a group at an event, is a different '
          + 'booking from one person for an hour, and the travelling and setting '
          + 'up is shared across it.' },
      { h: 'What has to be brought',
        p: 'A table, linen, oils, heating and music all travel to the address '
          + 'and are set up and packed away around the session itself.' },
      { h: 'Where and when',
        p: 'Distance, parking, stairs, and evening or weekend times all sit '
          + 'around the appointment rather than inside it, and are part of what '
          + 'is being priced.' },
    ],
    saving: [
      'Book two people back to back at one address so the travel and set-up are '
        + 'shared.',
      'Take a course of sessions if a regular treatment is the plan — blocks '
        + 'are usually better value than single bookings.',
      'Have the room clear, warm and quiet before they arrive. It is the part '
        + 'of the appointment you control.',
    ],
  },

  'mobile makeup artist': {
    factors: [
      { h: 'The occasion',
        p: 'An everyday or event look, a photographic or film look and a bridal '
          + 'look are different amounts of work. Bridal is usually its own price '
          + 'because it includes a trial, a longer wear time and being there for '
          + 'the morning.' },
      { h: 'Whether there is a trial',
        p: 'A trial is a full separate appointment, and for anything that has to '
          + 'be right the first time it is the appointment that makes the second '
          + 'one work.' },
      { h: 'How many faces',
        p: 'A party of bridesmaids is priced per person and takes the artist’s '
          + 'whole morning; the group booking is what the timings are built '
          + 'around.' },
      { h: 'What is added',
        p: 'Strip or individual lashes, airbrush application, hair as well as '
          + 'makeup, and touch-ups later in the day are separate items.' },
      { h: 'When and where',
        p: 'Very early starts, travel to a venue and staying on for the day are '
          + 'part of the booking rather than extras to it.' },
    ],
    saving: [
      'Book the whole party into one visit and one address.',
      'Be ready when they arrive — clean, moisturised skin and hair already '
        + 'done if hair is not part of the booking.',
      'Decide whether you actually need the artist to stay for touch-ups, or '
        + 'whether a small kit and a lipstick will do.',
    ],
  },

  'mobile notary': {
    factors: [
      { h: 'How many signatures',
        p: 'Notarial acts are counted individually, and many jurisdictions cap '
          + 'what may be charged per act by statute. Where that is so, the '
          + 'capped fee is not negotiable in either direction.' },
      { h: 'The travel itself',
        p: 'A mobile notary’s travel fee is generally separate from the act '
          + 'fee, and it is the part that varies with distance, time of day and '
          + 'how fast it has to happen.' },
      { h: 'What kind of signing it is',
        p: 'A single acknowledgement is minutes. A property or loan signing is a '
          + 'package of documents that has to be worked through page by page in '
          + 'a set order, and it is priced as its own kind of appointment.' },
      { h: 'When and where',
        p: 'Evenings, weekends, hospitals, care homes and prisons all involve '
          + 'more arranging than a weekday visit to an office, and same-day '
          + 'requests are priced as the urgency they are.' },
      { h: 'How many people are signing',
        p: 'Every signer needs identification checked individually, and a '
          + 'witness that has to be provided rather than found by you is a '
          + 'separate arrangement.' },
    ],
    saving: [
      'Have every signer present with current photographic identification. A '
        + 'failed appointment is still a journey somebody made.',
      'Have the documents complete and unsigned — signing in advance is the '
        + 'commonest reason a notarisation cannot go ahead.',
      'Do all the documents in one visit, and book ahead rather than same day.',
    ],
  },

  'personal fitness training': {
    factors: [
      { h: 'How long the session is',
        p: 'The unit of this trade is the hour, or the half hour, and the price '
          + 'follows it.' },
      { h: 'Buying sessions singly or in a block',
        p: 'Blocks are almost always better value per session, and they are '
          + 'also what makes the training work — a programme is a sequence '
          + 'rather than an event.' },
      { h: 'How many people train together',
        p: 'One to one, a pair, or a small group are priced very differently per '
          + 'head, because the trainer’s hour is being shared.' },
      { h: 'What has to be brought and where',
        p: 'A trainer who arrives with weights, bands and mats is carrying the '
          + 'equipment cost and the travel. Training in a park, at your home or '
          + 'at a gym you already belong to are all different arrangements.' },
      { h: 'What is around the sessions',
        p: 'Programming, nutritional guidance, check-ins between sessions and '
          + 'rehabilitation work after an injury are real work outside the hour, '
          + 'and are either included or priced separately.' },
    ],
    saving: [
      'Buy a block rather than single sessions, once you know the trainer suits '
        + 'you.',
      'Train with a friend. Two people sharing an hour is usually much less per '
        + 'person.',
      'Do the programme between sessions. Paying somebody to watch you repeat '
        + 'the same week is the most expensive way to train.',
    ],
  },

  tutoring: {
    factors: [
      { h: 'The level being taught',
        p: 'Primary, secondary, examination and university level are different '
          + 'amounts of subject knowledge and preparation, and are priced '
          + 'accordingly.' },
      { h: 'The subject',
        p: 'Subjects where few people can teach at the level required — '
          + 'specialist sciences, higher mathematics, less common languages — '
          + 'cost more for the ordinary reason that fewer people can do it.' },
      { h: 'Session length and frequency',
        p: 'A weekly hour and a twice-weekly ninety minutes are different '
          + 'commitments, and blocks are usually better value than single '
          + 'lessons.' },
      { h: 'One student or several',
        p: 'A small group shares the tutor’s hour and the cost with it, at the '
          + 'price of less attention each.' },
      { h: 'Preparation and marking',
        p: 'Work set, marked and fed back between lessons is time outside the '
          + 'lesson. Some tutors include it and some price it separately, and it '
          + 'is worth asking which.' },
      { h: 'Travelling to you',
        p: 'An in-person lesson at your address carries the journey either side '
          + 'of it, which an online lesson does not.' },
    ],
    saving: [
      'Start before the term the examination is in. Crisis tutoring in the last '
        + 'six weeks buys the least improvement for the most money.',
      'Take a block at a regular time rather than booking lesson by lesson.',
      'Make sure the work set between lessons actually gets done — it is what '
        + 'the lessons are for.',
    ],
  },

  'mobile photography and photo booths': {
    factors: [
      { h: 'How many hours of coverage',
        p: 'The booking is bought in hours on the day, and that is the single '
          + 'biggest lever on the price of any event work.' },
      { h: 'What happens afterwards',
        p: 'Culling, editing and retouching take longer than the shoot on most '
          + 'jobs, and the number of finished images and how finished they are is '
          + 'a large part of what is being paid for.' },
      { h: 'What you get at the end',
        p: 'Digital files, prints, an album or a booth’s printed strips are '
          + 'different deliverables with different costs behind them, and an '
          + 'album is a manufactured object as well as a design job.' },
      { h: 'How many people are working',
        p: 'A second photographer, an assistant, or an attendant for a booth are '
          + 'each another person’s day.' },
      { h: 'What has to be set up',
        p: 'A booth, a backdrop, lighting and props are delivered, built, staffed '
          + 'and taken away again, and that time surrounds the hours you are '
          + 'actually being photographed for.' },
      { h: 'When and where',
        p: 'Travel, a venue that needs an early set-up, and peak dates in the '
          + 'season are all part of what is priced.' },
    ],
    saving: [
      'Book the hours you actually need photographed rather than the whole day, '
        + 'and think about which hours those are.',
      'Take the digital files and arrange your own prints or album if design is '
        + 'not what you are paying for.',
      'Ask about off-peak dates and days. The difference in this trade is real.',
    ],
  },

  'tech support': {
    factors: [
      { h: 'Remote or at your address',
        p: 'A great deal of this work can be done over a remote connection, '
          + 'which costs no travel and can often start immediately. A visit is '
          + 'for the things that need hands on the hardware.' },
      { h: 'How the time is sold',
        p: 'An hourly rate with a minimum, a fixed price for a defined job, or a '
          + 'monthly arrangement for a small business are all common, and which '
          + 'suits depends on whether the problem is known.' },
      { h: 'Diagnosis against the fix',
        p: 'Finding an intermittent fault takes as long as it takes and has very '
          + 'little to do with what fixing it costs. A machine that fails once a '
          + 'week is the hard case.' },
      { h: 'Whether hardware is involved',
        p: 'A part — a drive, memory, a battery, a router — is on top of the '
          + 'labour, and on older machines the part may not be worth fitting.' },
      { h: 'Data recovery',
        p: 'Recovering files from a failing drive is its own specialism with its '
          + 'own equipment, and a physically damaged drive goes to a laboratory '
          + 'rather than to a support visit. It is not a routine job at a routine '
          + 'price.' },
      { h: 'How many machines',
        p: 'A household or an office done in one visit shares the journey and '
          + 'the setting up.' },
    ],
    saving: [
      'Have a backup before you need one. Every recovery is more expensive than '
        + 'the backup that would have made it unnecessary.',
      'Write down exactly what happens and when. Time not spent reproducing the '
        + 'fault is time spent fixing it.',
      'Ask whether it can be done remotely. Often it can, and that is a whole '
        + 'journey saved.',
      'Do all the machines in one visit.',
    ],
  },

  'mobile dog gym': {
    factors: [
      { h: 'How long the session is',
        p: 'Exercise and training are bought by the session, and the length of '
          + 'it is the base of the price.' },
      { h: 'One dog or several',
        p: 'A single dog gets the whole session. A group walk or class shares '
          + 'the handler across several animals and costs less per dog, but is '
          + 'not suitable for every dog.' },
      { h: 'Exercise or behaviour work',
        p: 'Running a fit dog and working on reactivity, recall or separation '
          + 'anxiety are different pieces of work. Behaviour work is a '
          + 'programme with homework between sessions, and it needs the owner in '
          + 'it as much as the dog.' },
      { h: 'What the dog is like to handle',
        p: 'A dog that is reactive to other dogs, nervous or very large needs a '
          + 'one-to-one arrangement and sometimes specific equipment or timing, '
          + 'and that is a different booking from joining a group.' },
      { h: 'Travel and collection',
        p: 'Collecting and returning the dog is time and mileage around the '
          + 'session itself.' },
    ],
    saving: [
      'Book a block or a regular weekly slot rather than single sessions.',
      'Join a group if your dog is sociable and the goal is exercise rather '
        + 'than behaviour work.',
      'Do the homework between sessions. Training that only happens while '
        + 'somebody is being paid does not stick.',
    ],
  },

  'mobile veterinary service': {
    factors: [
      { h: 'What the visit is for',
        p: 'A routine vaccination or health check, a consultation about a '
          + 'specific problem and an urgent visit are different lengths of '
          + 'appointment and different amounts of preparation.' },
      { h: 'How many animals',
        p: 'A household seen in one visit shares the journey. Each animal still '
          + 'needs its own examination and its own record.' },
      { h: 'What is done during the visit',
        p: 'Consultation, vaccination, blood or urine samples, imaging and '
          + 'medication are itemised separately nearly everywhere, and samples '
          + 'sent to a laboratory carry that laboratory’s own fee.' },
      { h: 'Whether it can be done at home at all',
        p: 'Some procedures need a clinic — anaesthesia, surgery, radiography '
          + 'and anything needing hospitalisation — so a home visit may end in a '
          + 'referral rather than a treatment.' },
      { h: 'When you call',
        p: 'Out-of-hours and emergency veterinary care is priced differently '
          + 'from a planned appointment, and that is universal in the '
          + 'profession.' },
      { h: 'The animal itself',
        p: 'Size, species and how it handles being examined all change how long '
          + 'a visit takes and whether a second pair of hands is needed.' },
    ],
    saving: [
      'Keep vaccinations and parasite treatment up to date. Preventive care is '
        + 'much cheaper than what it prevents.',
      'Have every animal in the household seen at one visit.',
      'Ask for an estimate before treatment begins, and ask what each item on '
        + 'it is for. Any good practice expects that question.',
      'Look into insurance before it is needed rather than after — a condition '
        + 'that has already appeared will not be covered.',
    ],
  },

  'food trucks': {
    factors: [
      { h: 'How many people are being fed',
        p: 'Headcount drives the food cost, the number of staff and how long '
          + 'the service window has to be.' },
      { h: 'What is on the menu',
        p: 'Ingredients differ enormously in cost, and so does how long each '
          + 'dish takes to make to order. A menu built for volume serves faster '
          + 'and costs less per head than one built for choice.' },
      { h: 'How long the service runs',
        p: 'A one-hour service and an all-evening one are different amounts of '
          + 'staff time either side of the same set-up.' },
      { h: 'Staffing',
        p: 'Every additional person serving is a shift, and a queue that is too '
          + 'slow is usually a staffing decision rather than a cooking one.' },
      { h: 'The site',
        p: 'Distance, access for the vehicle, whether there is power on site or '
          + 'a generator has to be run, and whether the venue charges for a '
          + 'pitch are all real costs before any food is cooked.' },
      { h: 'When it is',
        p: 'Peak weekends in the season are booked long ahead and priced '
          + 'accordingly, and most operators work to a minimum spend for a '
          + 'private booking.' },
    ],
    saving: [
      'Take a shorter set menu rather than a wide one. It serves faster and it '
        + 'costs less.',
      'Ask what a midweek or off-season date does to the price.',
      'Have power and vehicle access sorted on the site. A generator and a long '
        + 'carry are both avoidable costs.',
      'Give an accurate headcount. Catering for a number that does not turn up '
        + 'is the most wasteful thing you can pay for.',
    ],
  },

  'coffee and smoothie trucks': {
    factors: [
      { h: 'How many drinks, and over how long',
        p: 'A morning of unlimited service for two hundred people and a two-hour '
          + 'window for fifty are different bookings in both directions — the '
          + 'total cups and the length of the shift are priced separately.' },
      { h: 'What is being served',
        p: 'Espresso-based drinks take a barista and a machine and are made one '
          + 'at a time; batch brew, iced drinks and smoothies serve much faster. '
          + 'Speciality beans, alternative milks and syrups are ingredient '
          + 'costs.' },
      { h: 'How many staff',
        p: 'A single barista has a real limit on drinks an hour. A second one '
          + 'roughly doubles it, and that is the choice being made when a queue '
          + 'is the concern.' },
      { h: 'Power and water',
        p: 'A commercial machine needs real power. Mains on site is '
          + 'straightforward; a generator is a cost and it is noise.' },
      { h: 'Branding and extras',
        p: 'Printed cups, a custom menu or a wrapped vehicle are additions '
          + 'rather than part of the service.' },
      { h: 'Where and when',
        p: 'Travel, parking, early starts and peak dates sit around the service '
          + 'hours.' },
    ],
    saving: [
      'Serve a short menu. Every extra option slows the queue and adds stock.',
      'Book the hours people will actually be drinking rather than the whole '
        + 'event.',
      'Have mains power available if you possibly can.',
    ],
  },

  'dessert trucks': {
    factors: [
      { h: 'Headcount',
        p: 'The base of it: how many portions are being made and how many staff '
          + 'are needed to serve them in the window.' },
      { h: 'What is being served',
        p: 'Ice cream scooped to order, made-to-order crêpes or waffles, and a '
          + 'display of pre-made desserts are very different in service speed '
          + 'and in ingredient cost.' },
      { h: 'How long the service lasts',
        p: 'A short dessert window after a meal and an open truck all evening '
          + 'are different shifts.' },
      { h: 'Dietary requirements',
        p: 'Gluten-free, dairy-free and nut-free options mean separate '
          + 'ingredients and separate handling to avoid cross-contamination, and '
          + 'that is preparation as well as stock.' },
      { h: 'The site and the season',
        p: 'Power, access, distance and peak summer dates all sit around the '
          + 'booking, and most operators work to a minimum spend.' },
    ],
    saving: [
      'Pick two or three options rather than a full menu.',
      'Take a defined service window rather than open service all evening.',
      'Ask about midweek and off-season dates.',
    ],
  },

  'mobile bar service': {
    factors: [
      { h: 'Who is buying the drinks',
        p: 'The largest question in the trade. An open bar the host pays for, a '
          + 'cash bar the guests pay for, and a limited tab are entirely '
          + 'different arrangements, and only the first has an open-ended cost '
          + 'on your side.' },
      { h: 'How many guests, and for how long',
        p: 'Headcount times hours is what the stock and the staffing are built '
          + 'from.' },
      { h: 'What is being served',
        p: 'Beer and wine is one thing; a full cocktail list made to order is '
          + 'another, and it needs more staff, more equipment, more ingredients '
          + 'and more time per drink.' },
      { h: 'Staffing',
        p: 'Bartenders are shifts, including the setting up before and the '
          + 'clearing away after, which is often two hours around a service that '
          + 'the guests never see.' },
      { h: 'Licensing and insurance',
        p: 'Serving alcohol is regulated. Whether a licence is needed for the '
          + 'event, and who holds it, is a real part of the arrangement rather '
          + 'than a formality — and some venues require it be theirs.' },
      { h: 'What has to be brought',
        p: 'The bar itself, glassware, ice, refrigeration, power and the '
          + 'transport for all of it. Ice and refrigeration in particular are '
          + 'costs people rarely account for.' },
    ],
    saving: [
      'Offer a short signature list rather than a full bar. It serves faster, '
        + 'wastes less and buys less stock.',
      'Consider beer, wine and one or two cocktails instead of an open '
        + 'cocktail menu.',
      'Set a tab limit rather than an open bar if the total matters.',
      'Ask whether you can supply the alcohol yourself and pay for the service '
        + 'and the staff. Where the licensing allows it, that is the biggest '
        + 'single saving available.',
    ],
  },
};

/**
 * The written cost factors for a trade, or nothing.
 *
 * Nothing is the correct answer for a trade with no entry, and the sections
 * that use this are simply not drawn. There is no fallback text: a generic
 * paragraph about "the size of the job" printed under every trade would be
 * filler on the page whose entire argument is that it prints only what it can
 * stand behind.
 */
const costsFor = (slug: string): TradeCosts | null => TRADE_COSTS[slug] ?? null;

/**
 * The questions a cost page gets asked, and the answers this product can
 * actually stand behind.
 *
 * Kept in one array so the block on the page and the structured data below it
 * are built from the same words — a search engine quoting an answer the page
 * does not contain is worse than emitting no structured data at all, which is
 * what this page did until now.
 *
 * WHAT IS NOT IN HERE, and must not be added: a national average, a typical
 * cost, a price range for the trade at large, or anything phrased as "expect
 * to pay". Every answer below is either a fact about how Round The Way works — the
 * up-front labour payment, the parts quote, the cancellation ladder — or a
 * statement about where the figures on this page came from. Both are
 * checkable. A survey figure would not be, because there is no survey.
 */
function faqsFor(tradeName: string): { q: string; a: string }[] {
  return [
    {
      // The one answer this page and the trade page carry in identical words,
      // because it is the same question wherever it is asked — and because
      // both pages spent their whole existence implying the opposite answer.
      // src/lib/seo.ts renders the same string into the crawler's copy of this
      // URL, so the two halves of one address cannot disagree about it.
      q: 'Do I need an account?',
      a: ACCOUNT_TODAY_SHORT,
    },
    {
      q: `Are these average prices for ${tradeName}?`,
      a: `No. Every figure on this page is a price a business on Round The Way is `
        + `asking today for an appointment it has open, counted at the moment `
        + `the page loaded. We have no national survey for this trade and we `
        + `do not estimate one.`,
    },
    {
      q: 'Who sets these prices?',
      a: `The business doing the work. Every price here was listed by the `
        + `business whose name is on the appointment, and Round The Way does not `
        + `set or suggest any of them.`,
    },
    {
      q: 'Does the price include parts?',
      a: `It depends on the service, and the booking page says which before `
        + `you book: parts are either included in the price or quoted `
        + `separately. Where they are quoted, the business sends you a price `
        + `in your messages once they can see what is needed, and nothing is `
        + `fitted until you approve that price.`,
    },
    {
      q: 'When do I pay?',
      a: `${PAY_TODAY_SHORT} The labour is paid for here, on the site, at the `
        + `moment you book, with no cash and nothing paid at the door.`,
    },
    {
      q: 'Why is the same job listed at two different prices?',
      a: `Because two different businesses listed it. Each one sets its own `
        + `prices, sets aside its own amount of time for the work, and covers `
        + `its own part of the city, so the same job name can be worth `
        + `different amounts to each of them.`,
    },
    {
      q: 'What does it cost to cancel?',
      a: `It depends how close to the appointment you are. More than 48 hours `
        + `away, all of it comes back. Inside 48 hours, three quarters comes `
        + `back. Inside 12 hours, a quarter — the business has kept that time `
        + `free and turned other work away for it. Change your mind within 30 `
        + `minutes of booking and you get all of it back, as long as the `
        + `appointment is still at least three hours away. It works the same `
        + `way in both directions: a business that cancels on you pays the `
        + `same.`,
    },
  ];
}

export default function CostGuide() {
  const { trade } = useParams<{ trade: string }>();
  /** The URL segment, lower-cased. NOT the stored slug — see `slug` below. */
  const segment = (trade ?? '').trim().toLowerCase();
  // For the per-place table below. The hook reports a failure as an empty list
  // rather than as an error, which is exactly right here: without the metro
  // records the page loses one optional section and keeps everything else.
  const metros = useMetros();

  const [slots, setSlots] = useState<PublicSlot[]>([]);
  /**
   * The neighbourhoods the same fetch returned, kept for their names.
   *
   * A row's `area_slug` is a slug and a slug is not a place name, so the block
   * at the foot of this page that sends somebody to "car wash and detailing in
   * Encino" needs the names the businesses themselves wrote. This page used to
   * throw them away because it had nowhere to put them.
   */
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [located, setLocated] = useState<{ postcode: string; place: string | null } | null>(null);
  const [cats, setCats] = useState<TradeCategory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const load = useCallback(async (pc?: string) => {
    if (pc) { setLocating(true); setLocateError(null); } else { setLoading(true); setError(null); }
    try {
      const res = await api.publicMap(pc);
      setSlots(res.slots);
      setAreas(res.areas);
      setLocated(res.located);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load the prices.';
      if (pc) setLocateError(msg); else setError(msg);
    } finally {
      setLoading(false); setLocating(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      // The full catalogue, not the public cut-down one: a trade with nothing
      // listed today still deserves its proper name and breadcrumb rather than
      // being treated as a bad link.
      try { setCats((await api.tradeCatalog()).categories); }
      catch { setCats([]); }
    })();
  }, []);

  /**
   * THE STORED SLUG, RESOLVED OUT OF THE CATALOGUE RATHER THAN OFF THE URL.
   *
   * The Worker canonicalised this page's address to the hyphenated form —
   * /cost/junk-removal — while the value on an operator row, in `slot.trade`
   * and in the catalogue is still 'junk removal'. Everything below wants the
   * stored one: `s.trade === slug`, `costsFor(slug)`, the catalogue lookup.
   * Taking the segment at face value is why a direct load or a click from a
   * search result rendered "we do not have this trade" while in-app
   * navigation, which happened to pass the stored spelling, did not.
   *
   * Keyed on `cats` on purpose: until the catalogue lands there is nothing
   * here that knows the real stored values, so this is the segment meanwhile
   * and becomes the stored slug the moment the answer arrives. Every memo
   * below keys on THIS rather than on the parameter, which is what makes them
   * recompute with the right value once it does.
   */
  const slug = useMemo(
    () => storedTradeSlug(segment, cats?.flatMap((c) => c.trades)),
    [segment, cats],
  );

  const placeInCatalog = useMemo(() => {
    for (const c of cats ?? []) {
      const t = c.trades.find((x) => x.slug === slug);
      if (t) return { category: c, trade: t };
    }
    return null;
  }, [cats, slug]);

  /**
   * The rows in this trade as the map hands them over: one per neighbourhood
   * the opening is offered in. Only the "where is it open" block below wants
   * them that way, because that block is counting per neighbourhood.
   */
  const tagged = useMemo(() => slots.filter((s) => s.trade === slug), [slots, slug]);

  /**
   * The same trade, one row per opening.
   *
   * EVERY PRICE ON THIS PAGE IS COUNTED FROM THIS LIST AND NOT FROM `tagged`.
   * A business's whole free day has no location, so the map offers it in every
   * neighbourhood that business covers — genuinely true, and double counting
   * the moment a page adds prices up across the city. Counting the rows would
   * have said "11 businesses list this" beside a job two businesses list in
   * five areas each, and the Worker's copy of this page (seo.ts, via
   * `distinctGaps`) would have said something different on the same URL.
   */
  const inTrade = useMemo(() => distinctGaps(tagged), [tagged]);

  // Same rule as Trade's: a slug in no catalogue with nothing listed under it
  // gets the "we do not have this trade" page, so the tab must not promise a
  // price guide that does not exist.
  useDocumentTitle(
    placeInCatalog ? `What ${placeInCatalog.trade.label.toLowerCase()} costs`
      : cats === null ? null
        : inTrade.length > 0 ? `What ${slug} costs`
          : 'Trade not listed');

  /**
   * One currency only.
   *
   * A median taken across dollars and pounds is not a price, it is an average
   * of two different units. In practice everything listed here is in one
   * currency, so this is a guard rather than a feature: take whichever
   * currency the most listings are in and report on those, so the figures at
   * the top of the page are always comparable with each other.
   */
  const currency = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of inTrade) n.set(s.currency, (n.get(s.currency) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [inTrade]);

  const priced = useMemo(
    () => (currency ? inTrade.filter((s) => s.currency === currency) : []),
    [inTrade, currency],
  );

  const stats = useMemo(() => {
    const cents = priced.map((s) => s.price_cents).sort((a, b) => a - b);
    return {
      n: cents.length,
      low: cents[0] ?? null,
      high: cents[cents.length - 1] ?? null,
      mid: median(cents),
      businesses: new Set(priced.map((s) => s.operator_id)).size,
      // Seeded listings are real prices set by a real operator record, but they
      // are not a real business trading, so the page says how many of the rows
      // behind these figures are samples rather than quietly counting them in.
      samples: priced.filter((s) => s.is_sample).length,
    };
  }, [priced]);

  /**
   * The individual services, which is what somebody actually wants to compare.
   * Grouped by name because five businesses all listing "Full valet" is one
   * row a reader can use, and five rows they have to reconcile themselves.
   */
  const services = useMemo(() => {
    const by = new Map<string, PublicSlot[]>();
    for (const s of priced) {
      const list = by.get(s.service_name);
      if (list) list.push(s); else by.set(s.service_name, [s]);
    }
    return [...by.entries()]
      .map(([serviceName, rows]) => {
        const cents = rows.map((r) => r.price_cents).sort((a, b) => a - b);
        const mins = rows.map((r) => Math.round(r.duration_seconds / 60)).sort((a, b) => a - b);
        return {
          serviceName,
          n: rows.length,
          low: cents[0] ?? 0,
          high: cents[cents.length - 1] ?? 0,
          minMinutes: mins[0] ?? 0,
          maxMinutes: mins[mins.length - 1] ?? 0,
        };
      })
      // Cheapest first: this is a page somebody arrived on because they are
      // worried about the price, so the smallest number goes at the top.
      .sort((a, b) => a.low - b.low || a.serviceName.localeCompare(b.serviceName));
  }, [priced]);

  /**
   * The two things the sections below assert, counted rather than asserted.
   *
   * "A longer job costs more" and "every business sets its own price" are the
   * sort of sentence a cost guide writes whether or not its data shows it.
   * These are the same two claims read off the rows: the shortest and longest
   * blocks anybody has set aside for this trade, and how many job names two or
   * more businesses list at prices that are not the same. Where a count comes
   * back at nothing the sentence it would have supported is not printed.
   */
  const evidence = useMemo(() => {
    const shared = services.filter((s) => s.n > 1);
    return {
      shortest: services.reduce<number | null>(
        (m, s) => (m === null || s.minMinutes < m ? s.minMinutes : m), null),
      longest: services.reduce<number | null>(
        (m, s) => (m === null || s.maxMinutes > m ? s.maxMinutes : m), null),
      differing: shared.filter((s) => s.low !== s.high).length,
    };
  }, [services]);

  /**
   * WHAT IT IS LISTED AT IN EACH PLACE.
   *
   * The reference marketplace's junk removal guide carries a table of
   * twenty-one cities against a price range each, and it is the module a cost
   * page most obviously owes its reader: "what does it cost" nearly always
   * means "what does it cost here". Theirs are modelled from a national figure
   * adjusted for the city. Ours are not modelled at all — each row is the
   * listings that are actually open in that metro, counted the same way the
   * headline figures above are counted.
   *
   * SO ENOUGH APPLIES PER ROW, NOT ONLY TO THE PAGE. A trade can clear the bar
   * across both metros and be a single listing in one of them, and printing
   * "$40 – $220" beside a place with two prices in it would be exactly the
   * invented range this page refuses at the top. A thin row says how thin it
   * is and keeps its link; a place with nothing listed is left off entirely,
   * because a row of dashes is a way of implying we looked and the trade is
   * expensive there rather than that it is absent.
   *
   * THE DEDUPLICATION IS PER METRO AND THAT IS DELIBERATE. `tagged` has one row
   * per neighbourhood, so a business's whole free day appears once for each
   * area it covers; each metro's own count therefore dedupes on the opening
   * within itself, which makes every row correct on its own terms. A single
   * opening offered across two metros would be counted in both, so the rows do
   * not sum to the page total — which is why nothing below adds them up.
   */
  const byMetro = useMemo(() => {
    const metroOf = new Map(areas.map((a) => [a.slug, a.metro] as const));
    const rows = new Map<string, { seen: Set<string>; cents: number[]; ops: Set<string> }>();
    for (const s of tagged) {
      if (currency && s.currency !== currency) continue;
      const m = metroOf.get(s.area_slug);
      if (!m) continue;
      let row = rows.get(m);
      if (!row) { row = { seen: new Set(), cents: [], ops: new Set() }; rows.set(m, row); }
      if (row.seen.has(s.gap_id)) continue;
      row.seen.add(s.gap_id);
      row.cents.push(s.price_cents);
      row.ops.add(s.operator_id);
    }
    // Ordered by the metro list rather than by price or by size, so the table
    // reads the same on every cost guide on the site. A metro the records do
    // not name is dropped: there is one source for these names and a shorter
    // table is better than one with a slug in it.
    return metros.flatMap((m) => {
      const row = rows.get(m.slug);
      if (!row || row.cents.length === 0) return [];
      const cents = row.cents.sort((a, b) => a - b);
      return [{
        slug: m.slug,
        name: m.name,
        path: m.path,
        n: cents.length,
        businesses: row.ops.size,
        low: cents[0] ?? null,
        mid: median(cents),
        high: cents[cents.length - 1] ?? null,
      }];
    });
  }, [tagged, areas, metros, currency]);

  /**
   * WHERE THIS TRADE IS OPEN, counted rather than listed.
   *
   * The reference marketplace ends its cost guide with "find <trade> near
   * you", and the honest version of that here is not a promise of coverage but
   * the list of neighbourhoods that actually have an appointment open in this
   * trade at this moment, each with its own count. A neighbourhood is on the
   * list because a row said so; nowhere with nothing open is listed, because
   * the link would land on a page with nothing on it.
   *
   * A neighbourhood whose name did not come back is dropped rather than shown
   * as its slug: there is one source for these names and a shorter list is
   * better than a guessed one. Trade.tsx builds the same block the same way.
   */
  const openWhere = useMemo(() => {
    const names = new Map(areas.map((a) => [a.slug, a.name] as const));
    const n = new Map<string, number>();
    for (const s of tagged) n.set(s.area_slug, (n.get(s.area_slug) ?? 0) + 1);
    return [...n.entries()]
      .flatMap(([areaSlug, count]) => {
        const nm = names.get(areaSlug);
        return nm ? [{ slug: areaSlug, name: nm, n: count }] : [];
      })
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [tagged, areas]);

  /**
   * How many openings each trade has, by slug, for the block of other cost
   * guides at the foot of the page.
   *
   * Deduplicated on the opening: the map offers a whole free day in every
   * neighbourhood its owner covers, so counting rows would count one
   * business's Tuesday once per area and put a number beside another trade's
   * guide that its own page would contradict. seo.ts counts the same way.
   */
  const openByTrade = useMemo(() => {
    const seen = new Set<string>();
    const n = new Map<string, number>();
    for (const s of slots) {
      if (seen.has(s.gap_id)) continue;
      seen.add(s.gap_id);
      const t = (s.trade ?? '').trim().toLowerCase();
      if (t) n.set(t, (n.get(t) ?? 0) + 1);
    }
    return n;
  }, [slots]);

  if (loading) {
    return <PublicPage className="tr-page"><Spinner label="Reading listed prices" /></PublicPage>;
  }
  if (error) {
    return (
      <PublicPage className="tr-page">
      <ErrorNote error={error} onRetry={() => void load()} />
      </PublicPage>
    );
  }

  // The catalogue's label, for the reason set out over `name` in Trade: the
  // trail, the heading and the prose all have to call this the same thing.
  const name = placeInCatalog ? placeInCatalog.trade.label : sentence(slug);
  const lower = name.toLowerCase();
  const near = located?.place ?? located?.postcode ?? null;
  const alertHref = located ? `/a?postcode=${encodeURIComponent(located.postcode)}` : '/a';
  // Named for what it points at rather than `tradeHref`, which is now the
  // shared minter imported above and would be shadowed by a local of that name.
  const tradePageHref = tradeHref(slug);
  const cheapest = priced.reduce<PublicSlot | null>(
    (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
  /**
   * The cheapest one a reader can actually book, which is not always the
   * cheapest one listed.
   *
   * `cheapest` above counts every row, samples included, and that is right for
   * the summary line: it reports what is listed, and the summary says in its
   * own bullet how many of the rows are seeded. It was also wired to the Book
   * link at the bottom of this page, which is a different kind of statement —
   * that link is an offer, and an offer to book a business that does not exist
   * ends at the pricing step with `sample_listing`. On a deployment whose
   * listings are still mostly seeded that was the likeliest press on the whole
   * page.
   *
   * So the link follows the cheapest non-sample row and the figures carry on
   * counting everything. Where every listing in the trade is a sample this is
   * null and the link is simply not drawn — there is nothing to book, and a
   * page with no link says that more honestly than a link that refuses.
   * `cheapestReal` in src/lib/seo.ts is the same rule on the server.
   */
  const bookable = priced.filter((s) => !s.is_sample).reduce<PublicSlot | null>(
    (best, s) => (!best || s.price_cents < best.price_cents ? s : best), null);
  const faqs = faqsFor(lower);
  // Written knowledge about the work itself, or nothing at all for a trade
  // where there is nothing truthful to say about labour. Every section built
  // from this is drawn only when its own field is present, so a partial entry
  // costs a section rather than producing an empty one.
  const costs = costsFor(slug);

  // A slug nobody lists under, and which is in no catalogue, is an old link or
  // a typo. A sentence and a way out, never a blank page.
  if (cats !== null && !placeInCatalog && inTrade.length === 0) {
    return (
      <PublicPage className="tr-page">
        {/* Nothing to put in a trail here: it would be "Round The Way" alone,
            which is the link the wordmark already is. Crumbs renders nothing
            for an empty list, so there is no call to make. */}
        <section className="tr-empty">
          <h1>We do not have this trade</h1>
          <p>
            Nothing on Round The Way is listed under that name, so there are no
            prices to report for it. Everything that is open is on the front
            page.
          </p>
          <div className="tr-empty-do">
            <Link className="btn" to="/">See what is open</Link>
          </div>
        </section>
      </PublicPage>
    );
  }

  /**
   * The other cost guides worth offering, and the counts beside them.
   *
   * The reference marketplace closes its cost guide with a block of a dozen
   * links into other cost guides, which is the single most useful thing on the
   * page for somebody who arrived on the wrong one. Ours is built from the
   * catalogue: the trades in the same category, busiest first, and the busiest
   * trades on the site for a slug the catalogue has never heard of. The number
   * is openings counted from the rows fetched a moment ago, and every opening
   * carries a price, so it is a count of what that guide will actually show.
   */
  const related = (placeInCatalog
    ? placeInCatalog.category.trades.filter((t) => t.slug !== slug)
    : (cats ?? []).flatMap((c) => c.trades).filter((t) => t.slug !== slug))
    .map((t) => ({ ...t, n: openByTrade.get(t.slug) ?? 0 }))
    .filter((t) => placeInCatalog !== null || t.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 8);

  /**
   * The table of contents, built from the sections this render actually
   * produces rather than from a written-down list.
   *
   * The page got long enough to need one — that is the whole reason the
   * reference marketplace carries one — and a contents list that offers a
   * heading the page does not contain is worse than none at all. So the
   * entries are assembled here, beside the conditions that decide whether each
   * section is drawn, and the ids are the ones those sections carry.
   */
  const toc: Array<{ id: string; label: string }> = [
    ...(stats.n >= ENOUGH ? [{ id: 'cg-range', label: 'Listed prices today' }] : []),
    ...(stats.n > 0 && stats.n < ENOUGH
      ? [{ id: 'cg-thin', label: 'Too few listings to give a range' }] : []),
    // Only worth offering when there is more than one place to compare. On a
    // single-metro render the table would be one row restating the headline.
    ...(byMetro.length > 1 ? [{ id: 'cg-metro', label: 'What it is listed at in each place' }] : []),
    ...(services.length > 0 && currency
      ? [{ id: 'cg-svc', label: 'What each job is listed at' }] : []),
    ...(costs ? [{ id: 'cg-factors', label: `What ${lower} prices depend on` }] : []),
    { id: 'cg-why', label: 'What changes the price on Round The Way' },
    ...(costs?.diy ? [{ id: 'cg-diy', label: 'Doing it yourself, or booking someone' }] : []),
    ...(costs?.saving ? [{ id: 'cg-save', label: 'Where the price can come down' }] : []),
    { id: 'cg-hire', label: `How to hire ${lower} on Round The Way` },
    { id: 'cg-faq', label: `Questions about what ${lower} costs` },
    ...(stats.n > 0 ? [{ id: 'cg-method', label: 'How we worked these figures out' }] : []),
    { id: 'cg-near', label: `Find ${lower} near you` },
    { id: 'cg-how', label: 'How booking one works' },
    ...(related.length > 0 ? [{ id: 'cg-guides', label: 'Other cost guides' }] : []),
  ];

  return (
    <PublicPage className="tr-page">
      {/*
        THE PINNED PRICE BANNER.

        The reference marketplace opens its cost guide with the range and the
        place it is for, and keeps it in view as you read down. It is worth
        copying: the number is what the visitor came for, and the page below it
        is long. Two things are different here. It only appears once there are
        enough listings to have a range at all — under that, the page says so
        instead, and a banner would be dressing two prices up as a market. And
        it only pins itself at 760px and up, where the site bar is a single row
        of known height; below that the header wraps to two rows and a bar
        pinned under a moving target would sit over the page's own words on the
        screen with the least room to spare. It holds no control of any kind,
        so there is nothing in it for the keyboard to get caught on.
      */}
      {stats.n >= ENOUGH && currency && stats.low !== null && stats.high !== null && (
        <div className="tr-pricebar">
          <p className="tr-pricebar-in">
            <b>
              {stats.low === stats.high
                ? money(stats.low, currency)
                : `${money(stats.low, currency)} – ${money(stats.high, currency)}`}
            </b>
            {stats.mid !== null && (
              <span className="tr-pricebar-mid">middle {money(stats.mid, currency)}</span>
            )}
            <span className="tr-pricebar-where">
              {stats.n} {stats.n === 1 ? 'price' : 'prices'} listed for {lower}
              {located
                ? `, from businesses that can reach ${near}`
                : ', everywhere Round The Way covers'}
            </span>
          </p>
        </div>
      )}

      {/* One step shorter than the trail this replaced, which also carried
          the category. The parent of a cost guide is the trade it prices,
          and that page carries the category crumb itself — repeating it here
          makes the reader walk two levels to reach a page that is one link
          away. Crumbs prepends Round The Way, and emits the BreadcrumbList the
          hand-rolled markup never did. */}
      <Crumbs items={[
        { label: placeInCatalog?.trade.label ?? name, to: tradePageHref },
        { label: 'Cost' },
      ]} />

      <header className="tr-head">
        <h1>
          What does {lower} cost{near ? <> near <em>{near}</em></> : null}?
        </h1>

        {/*
          WHERE THEIR BYLINE AND "LAST UPDATED" GO.

          The reference marketplace signs its cost guides with an author and a
          date, which is the right thing to do for a piece of writing somebody
          edits. Nobody edits this: it is a count taken off the listings while
          you wait. A date here would be a claim about a document that does not
          exist, so what stands in its place is the true version of the same
          promise — that the figures were fetched a second ago rather than
          filed away last winter.
        */}
        <p className="tr-asof">
          Counted live. These figures are read off the listings each time the
          page opens, so there is no author and no last-updated date to print.
        </p>

        {/*
          THE WHOLE INTEGRITY OF THE PAGE, in one paragraph, above the
          figures rather than in a footnote under them. It says exactly what
          these numbers are and exactly what they are not.
        */}
        <p className="tr-note">
          {stats.n === 0 ? (
            <>
              Nothing in this trade is listed on Round The Way at the moment, so
              there is no price for us to report. We do not have national
              survey figures and we are not going to estimate any.
            </>
          ) : (
            <>
              These are the prices <strong>{stats.businesses}{' '}
              {stats.businesses === 1 ? 'business' : 'businesses'} on Round The Way
              are asking right now</strong> for {lower} — {stats.n}{' '}
              {stats.n === 1 ? 'listing' : 'listings'} counted the moment this
              page loaded{located ? `, from businesses that can reach ${near}` : ''}.
              They are not a national average and they are not a survey. We do
              not have either of those, so we do not quote one.
              {/* "25 of the 25 are sample listings" is not a sentence
                  anybody writes. When every listing is seeded the honest and
                  shorter thing to say is that every listing is seeded. */}
              {stats.samples > 0 && (
                <>
                  {' '}
                  {stats.samples === stats.n
                    ? (stats.n === 1
                      ? 'That listing is a sample'
                      : `All ${stats.n} are sample listings`)
                    : `${stats.samples} of them ${
                      stats.samples === 1 ? 'is a sample listing' : 'are sample listings'}`}
                  {' '}we seeded ourselves rather than a business trading today.
                </>
              )}
            </>
          )}
        </p>

        <PostcodeFinder id="cg-postcode"
          label="Prices from businesses who can reach"
          locating={locating} error={locateError} near={near}
          showing="Counting only what can reach"
          onSearch={(pc) => void load(pc)}
          onClear={() => { setLocated(null); setLocateError(null); void load(); }} />
      </header>

      {/* --- the headline figures --------------------------------------- */}
      {stats.n === 0 ? (
        <section className="tr-sec">
          <div className="tr-empty">
            <h2>No prices listed for {lower} today</h2>
            <p>
              An opening here is an hour a business has free, so a trade can
              be empty one hour and full the next. Rather than estimate a
              price from nothing, we will tell you when somebody lists one.
            </p>
            <div className="tr-empty-do">
              <Link className="btn" to={alertHref}>Tell me when one appears</Link>
              <Link className="btn quiet" to="/">See every trade</Link>
            </div>
          </div>
        </section>
      ) : stats.n < ENOUGH ? (
        /*
          Two prices are two prices. Calling them a range, a spread or a
          typical cost would be inventing a pattern out of a coincidence, so
          the page says how thin the evidence is and shows the raw listings
          underneath instead.
        */
        <section className="tr-sec" aria-labelledby="cg-thin">
          <h2 id="cg-thin">Too few listings to give a range</h2>
          <p className="tr-sec-sub">
            Only {stats.n} {stats.n === 1 ? 'price is' : 'prices are'} listed for{' '}
            {lower} at the moment. That is not enough to say what the work
            usually costs, so here is exactly what is listed, and nothing more.
          </p>
        </section>
      ) : (
        <section className="tr-sec" aria-labelledby="cg-range">
          <h2 id="cg-range">Listed prices today</h2>
          <p className="tr-sec-sub">
            The cheapest and dearest of the {stats.n} listings, and the one in
            the middle.
          </p>
          <div className="tr-prices">
            {stats.low !== null && currency && (
              <div className="tr-price">
                <b>{money(stats.low, currency)}</b>
                <span>lowest listed</span>
              </div>
            )}
            {stats.mid !== null && currency && (
              <div className="tr-price mid">
                <b>{money(stats.mid, currency)}</b>
                <span>middle of the listings</span>
              </div>
            )}
            {stats.high !== null && currency && (
              <div className="tr-price">
                <b>{money(stats.high, currency)}</b>
                <span>highest listed</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* --- the short answer --------------------------------------------
          THE HIGHLIGHTS BULLETS, WITH NOTHING IN THEM THAT WAS NOT COUNTED.

          The reference marketplace opens a price page with four or five
          highlight bullets before any prose, and it is the right instinct: the
          reader typed a question and the page is five screens long. Theirs
          summarise a survey. Ours summarise the listings, which is the only
          thing this page has — so every figure below is one of the numbers
          already worked out above, restated in a line somebody can read in
          three seconds, and there is nothing here that is not repeated in full
          further down. That last part matters: a summary is allowed to be
          shorter than the page, and it is not allowed to be the only place a
          claim appears, because a claim nobody scrolls to cannot be checked. */}
      {stats.n > 0 && currency && (
        <section className="cg-key" aria-labelledby="cg-key-h">
          <h2 id="cg-key-h">The short answer</h2>
          <ul>
            {stats.n >= ENOUGH && stats.low !== null && stats.high !== null ? (
              <li>
                {stats.low === stats.high ? (
                  <>
                    Every one of the {stats.n} listings for {lower} is at{' '}
                    <b>{money(stats.low, currency)}</b> right now.
                  </>
                ) : (
                  <>
                    Listed prices for {lower} run from{' '}
                    <b>{money(stats.low, currency)}</b> to{' '}
                    <b>{money(stats.high, currency)}</b>
                    {stats.mid !== null && (
                      <>, with the middle listing at <b>{money(stats.mid, currency)}</b></>
                    )}.
                  </>
                )}
              </li>
            ) : (
              <li>
                Only {stats.n} {plural(stats.n, 'price is', 'prices are')} listed
                for {lower} at the moment, which is too few to give a range. What
                is listed is shown below exactly as it stands.
              </li>
            )}
            <li>
              That is {stats.n} {plural(stats.n, 'listing', 'listings')} from{' '}
              {stats.businesses} {plural(stats.businesses, 'business', 'businesses')}
              {services.length > 0 && (
                <>
                  {' '}under {services.length}{' '}
                  {plural(services.length, 'job name', 'different job names')}
                </>
              )}
              {located ? `, counting only businesses that can reach ${near}` : ''}.
            </li>
            {cheapest && (
              <li>
                The cheapest open right now is{' '}
                <b>{money(cheapest.price_cents, currency)}</b> for{' '}
                {cheapest.service_name.toLowerCase()}, {cheapest.when}.
              </li>
            )}
            {openWhere.length > 0 && (
              <li>
                It is open in {openWhere.length}{' '}
                {plural(openWhere.length, 'neighbourhood', 'neighbourhoods')}
                {byMetro.length > 1 && (
                  <> across {byMetro.map((m) => m.name).join(' and ')}</>
                )}
                {' '}at this moment.
              </li>
            )}
            {/* The caveat rides in the summary as well as in the note above.
                A reader who only reads the box has to meet it too. */}
            {stats.samples > 0 && (
              <li>
                {stats.samples === stats.n
                  ? (stats.n === 1
                    ? 'That listing is a sample'
                    : `All ${stats.n} are sample listings`)
                  : `${stats.samples} of them ${
                    stats.samples === 1 ? 'is a sample listing' : 'are sample listings'}`}
                {' '}we seeded ourselves rather than a business trading today.
              </li>
            )}
            <li>
              There is no national average on this page, because we have not
              measured one.
            </li>
          </ul>
        </section>
      )}

      {/* --- what is on this page ---------------------------------------
          A contents list, because the page is now long enough that the thing
          somebody came for can be three screens down. Built from `toc`, which
          is assembled next to the conditions that decide which sections exist,
          so it can never offer a heading that is not there. */}
      {stats.n > 0 && (
        <nav className="tr-sec tr-toc" aria-labelledby="cg-toc">
          <h2 id="cg-toc">On this page</h2>
          <ul>
            {toc.map((t) => (
              <li key={t.id}><a href={`#${t.id}`}>{t.label}</a></li>
            ))}
          </ul>
        </nav>
      )}

      {/* --- what it is listed at in each place ---------------------------
          THEIR CITY TABLE, WITHOUT THE MODELLING.

          The reference marketplace's junk removal guide runs a table of
          twenty-one cities against a price range each, and it is the single
          most useful module on any cost page — "what does this cost" is almost
          always "what does this cost HERE". Theirs are a national figure
          adjusted per city. Ours are counted per metro off the same listings
          the rest of the page is counted off, which is why this table has two
          rows in it rather than twenty-one, and why a place with too little
          listed says so in the price column instead of carrying a range.

          Only drawn when there is more than one place with something in it. A
          one-row table is the headline figure with extra furniture around it,
          and it would imply the other place had been checked and found
          expensive rather than found empty. */}
      {byMetro.length > 1 && currency && (
        <section className="tr-sec" aria-labelledby="cg-metro">
          <h2 id="cg-metro">What it is listed at in each place</h2>
          <p className="tr-sec-sub">
            The same count as above, taken one place at a time. A place with
            fewer than {ENOUGH} listings gets no range, for the same reason the
            page as a whole would not.
            {/* Said plainly rather than left for somebody to work out from the
                arithmetic: one business's free day is offered in every
                neighbourhood it covers, so a business working across a metro
                boundary is counted once in each. The rows are each correct and
                they are not meant to be added. */}
            {' '}The rows are counted separately and are not meant to be added
            together.
          </p>
          <div className="cg-metro-wrap" tabIndex={0} role="group"
            aria-label={`What ${lower} is listed at in each place`}>
            <table className="cg-metro">
              <thead>
                <tr>
                  <th scope="col">Place</th>
                  <th scope="col">Listed</th>
                  <th scope="col" className="cg-num">Listed prices</th>
                  <th scope="col" className="cg-num">Middle</th>
                </tr>
              </thead>
              <tbody>
                {byMetro.map((m) => (
                  <tr key={m.slug}>
                    <th scope="row">
                      {/* A plain anchor: the metro page is rendered by the
                          Worker and is not a React route, so a client-side
                          navigation would land on the SPA's catch-all. */}
                      <a href={m.path}>{m.name}</a>
                    </th>
                    <td className="cg-metro-n">
                      {m.n} {plural(m.n, 'listing', 'listings')} from{' '}
                      {m.businesses} {plural(m.businesses, 'business', 'businesses')}
                    </td>
                    {m.n >= ENOUGH && m.low !== null && m.high !== null ? (
                      <>
                        <td className="cg-num">
                          <b>
                            {m.low === m.high
                              ? money(m.low, currency)
                              : `${money(m.low, currency)} – ${money(m.high, currency)}`}
                          </b>
                        </td>
                        <td className="cg-num">
                          {m.mid !== null ? money(m.mid, currency) : '—'}
                        </td>
                      </>
                    ) : (
                      // One cell across both price columns rather than a range
                      // and a dash. The sentence is the answer here, and
                      // splitting it would leave a column of numbers with a
                      // gap in it that reads as missing data rather than as
                      // data we decline to invent.
                      <td className="cg-thin" colSpan={2}>
                        too few listed for a range
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* --- every service, by name ------------------------------------- */}
      {services.length > 0 && currency && (
        <section className="tr-sec" aria-labelledby="cg-svc">
          <h2 id="cg-svc">What each job is listed at</h2>
          <p className="tr-sec-sub">
            One row per service name, with what it is listed at and how long
            the business has set aside for it. Where more than one business
            lists the same job, the row shows the spread between them.
          </p>
          {/* The table has a minimum width and scrolls inside this box on a
              phone. A scroll container that only a mouse or a finger can
              reach strands anybody driving the page from the keyboard on the
              first column, so the box takes focus and says what it is. */}
          <div className="tr-table-wrap" tabIndex={0} role="group"
            aria-label={`What each ${lower} job is listed at`}>
            <table className="tr-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">How long</th>
                  <th scope="col" className="tr-num">Listed price</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.serviceName}>
                    <th scope="row">
                      {s.serviceName}
                      {s.n > 1 && (
                        // Listings, not businesses. One business can list the
                        // same service in several of its free hours, and
                        // calling five of those "five businesses" turns a
                        // repeated row into a market. seo.ts words the same
                        // cell the same way, and this said "businesses" until
                        // the two were read side by side.
                        <span className="tr-svc-n">
                          {s.n} listings
                        </span>
                      )}
                    </th>
                    <td>
                      {s.minMinutes === s.maxMinutes
                        ? duration(s.minMinutes)
                        : `${duration(s.minMinutes)} – ${duration(s.maxMinutes)}`}
                    </td>
                    <td className="tr-num">
                      {s.low === s.high
                        ? money(s.low, currency)
                        : `${money(s.low, currency)} – ${money(s.high, currency)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* --- what the work itself costs by ------------------------------
          THE COST-FACTOR LIST, WHICH IS KNOWLEDGE RATHER THAN A CLAIM.

          Every price page on the reference marketplace carries one of these,
          and it is the module this page went without for longest, because the
          rule the page is built on — print only what you counted — was read as
          forbidding anything written down. It does not. "A double-coated dog
          takes longer to groom than a short-haired one" is not a claim about
          Round The Way, it is not a claim about a business on it, and it does not
          need a survey behind it: it is how the trade works, and a page called
          "what does X cost" that cannot say why one X costs more than another
          is a price list wearing a guide's title.

          What keeps it inside the rule is the constraint written over
          TRADE_COSTS: nothing in any of these entries carries a number. The
          moment one says "adds about a third" it becomes an estimate sitting
          two sections below figures that were genuinely counted, where nothing
          in the typography tells a reader which is which.

          A trade with no entry gets no section at all. */}
      {costs && (
        <section className="tr-sec" aria-labelledby="cg-factors">
          <h2 id="cg-factors">What {lower} prices depend on</h2>
          <p className="tr-sec-sub">
            Why two jobs with the same name are not the same job. This part is
            about the work rather than about this site, so there are no figures
            in it — the figures on this page are all above, and all counted.
          </p>
          <dl className="cg-factors">
            {costs.factors.map((f) => (
              <div key={f.h}>
                <dt>{f.h}</dt>
                <dd>{f.p}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* --- what actually changes the number ---------------------------
          Three things, and all three are structural facts about how this
          product works rather than received wisdom about the trade. There is
          no "expect to pay 20% more at weekends" here, because we have not
          measured that and neither has anybody else we could cite. Where the
          rows on this page can show the claim rather than only state it, the
          figure is printed and it is counted from those rows.

          THE HEADING NARROWED WHEN THE SECTION ABOVE WAS ADDED. This was "What
          changes the price", written when it was the only such section on the
          page; with a cost-factor list now standing above it, that title
          claimed the whole subject while covering only the part of it that is
          about this marketplace. The two sections answer different questions —
          what the work costs by, and what these particular listings differ by —
          and the headings now say which is which. */}
      <section className="tr-sec" aria-labelledby="cg-why">
        <h2 id="cg-why">What changes the price on Round The Way</h2>
        <p className="tr-sec-sub">
          Three things about the listings above in particular, as against the
          trade in general. Only three, because these are the only ones we can
          actually stand behind.
        </p>
        <div className="tr-drivers">
          <div className="tr-driver">
            <h3>How long the job takes</h3>
            <p>
              Every listing above is a block of a business's day with a length
              on it, set by the business rather than by us. A longer block is
              more of their day, and it is priced that way by the person whose
              day it is.
            </p>
            {/* Only when the two ends are genuinely different: printing
                "between 90 min and 90 min" to illustrate a spread would be
                using a number to say the opposite of what it says. */}
            {evidence.shortest !== null && evidence.longest !== null
              && evidence.shortest !== evidence.longest && (
              <p>
                The jobs listed above run from {duration(evidence.shortest)}{' '}
                to {duration(evidence.longest)}, which is most of why the
                prices beside them are as far apart as they are.
              </p>
            )}
            <p>
              What makes one job longer than another is the state of the thing
              being worked on, and the business is the only one who can judge
              that. So the length is part of what they listed, and you can see
              it beside every price above before you choose one.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Whether it needs parts</h3>
            <p>
              Parts are handled apart from the price on the card, and the
              booking page says which way round it is for the service you are
              looking at: either parts are included in that price, or they are
              quoted separately.
            </p>
            <p>
              Where they are quoted, the price on the card is the labour, and
              the business sends you a price for the part in your messages
              once they can see what is needed. Nothing is fitted and nothing
              is ever added until you approve that price — not a rounding
              difference, and never cash at the door.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Who you are booking</h3>
            <p>
              Every business on Round The Way sets its own prices, sets aside its
              own amount of time, and lists only the parts of the city it
              covers. There is no rate card here and no suggested price: two
              businesses can list the same job for different amounts and both
              of them are right about their own work.
            </p>
            {/* A sentence that opens on a digit reads as a caption rather
                than as prose, so the count is moved off the front of it. */}
            {evidence.differing > 0 && (
              <p>
                In the table above, {evidence.differing}{' '}
                {evidence.differing === 1 ? 'job name is' : 'job names are'}{' '}
                listed by more than one business at more than one price, which
                is what that looks like in practice.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* --- doing it yourself -------------------------------------------
          THE MODULE A MARKETPLACE HAS EVERY COMMERCIAL REASON TO LEAVE OUT.

          The reference marketplace carries a "DIY vs hiring a pro" block on its
          price pages and it is worth copying honestly, which means the
          do-it-yourself column has to be a real answer rather than a straw man
          set up to be knocked down. Somebody who came to a cost page and left
          having decided to wash the car themselves was given the right answer,
          and a page that cannot say so is an advert.

          Written per trade and only where there genuinely is an amateur
          version. Work where the honest answer is "do not" — a lockout on a
          car, a treatment programme for bed bugs, a windscreen with a camera
          behind it — carries no `diy` entry at all, and this section does not
          appear rather than appearing with a discouraging paragraph in it. */}
      {costs?.diy && (
        <section className="tr-sec" aria-labelledby="cg-diy">
          <h2 id="cg-diy">Doing it yourself, or booking someone</h2>
          <p className="tr-sec-sub">
            The cheapest version of this job is sometimes not booking it at all,
            and a page about what it costs should say where that line falls.
          </p>
          <div className="cg-diy">
            <div>
              <h3>Doing it yourself</h3>
              <p>{costs.diy.yourself}</p>
            </div>
            <div>
              <h3>Worth booking someone for</h3>
              <p>{costs.diy.pro}</p>
            </div>
          </div>
        </section>
      )}

      {/* --- where the price can come down -------------------------------
          Their "how to save money on X" list. Every line here is something the
          reader does — clearing the space, grouping the jobs, saying what is in
          the load before the van arrives — rather than anything about our
          pricing, because we do not set the prices and have no discount to
          offer. Several of these cost the businesses on this site money, which
          is the test of whether the section is advice or marketing. */}
      {costs?.saving && costs.saving.length > 0 && (
        <section className="tr-sec" aria-labelledby="cg-save">
          <h2 id="cg-save">Where the price can come down</h2>
          <p className="tr-sec-sub">
            Things that genuinely make this job smaller or quicker. None of them
            is a discount from us — we do not set these prices and have none to
            give.
          </p>
          <ul className="cg-save">
            {costs.saving.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </section>
      )}

      {/* --- the standing call to action ---------------------------------
          Theirs is a "Get a free estimate" button dropped in mid-page. Ours
          cannot be: there is no quote request on a public page — estimates
          exist only inside a booked or guest thread — so a button reading "free
          estimate" would be a button that does not do what it says. What this
          band offers is the two things that actually exist at this point in the
          page, and it changes with the data: an open listing to look at when
          there is one, and the alert when there is not. Neither promises a
          price, a callback or a quote. */}
      <section className="cg-cta" aria-labelledby="cg-cta-h">
        <h2 id="cg-cta-h">
          {inTrade.length > 0
            ? `See what is actually open for ${lower}`
            : `Nothing is open for ${lower} right now`}
        </h2>
        <p>
          {inTrade.length > 0
            ? `Every figure above belongs to a particular hour of a particular `
              + `business's week. The listing page shows those hours with the `
              + `times, the businesses and the prices side by side, so you are `
              + `choosing an appointment rather than asking for a quote.`
            : `An opening here is an hour a business has free, so this trade can `
              + `be empty one hour and full the next. We will tell you when `
              + `somebody lists one rather than estimating what it would cost.`}
        </p>
        <div className="cg-cta-do">
          {inTrade.length > 0 && (
            <Link className="btn" to={tradePageHref}>
              {inTrade.length} {plural(inTrade.length, 'appointment', 'appointments')} open
            </Link>
          )}
          <Link className={inTrade.length > 0 ? 'btn quiet' : 'btn'} to={alertHref}>
            Tell me when one appears
          </Link>
        </div>
      </section>

      {/* --- how to hire ------------------------------------------------
          The reference marketplace's "how to hire a reliable X" is half advice
          and half a claim that its people have been checked. We check nobody,
          so every line below is a fact about what this site puts in front of
          you and what it does not — including the two places where the answer
          is that we do not know. A page whose whole argument is that its
          numbers are counted cannot then hand out advice it made up. */}
      <section className="tr-sec" aria-labelledby="cg-hire">
        <h2 id="cg-hire">How to hire {lower} on Round The Way</h2>
        <p className="tr-sec-sub">
          What there is to go on before you book, and what there is not.
        </p>
        <div className="tr-drivers">
          <div className="tr-driver">
            <h3>Read the price and the length together</h3>
            <p>
              Every listing is a block of one business's day: a price, and the
              time they have set aside for the work. The cheapest is not always
              the same job — a shorter block is less of their day — so every
              listing carries both, and the booking page shows both again
              before you commit to anything.
              {/* Deliberately not "the table above": on a trade with nothing
                  listed there is no table, and this section is drawn either
                  way because it is about how to choose rather than about
                  today's rows. */}
            </p>
          </div>
          <div className="tr-driver">
            <h3>Check what the price covers</h3>
            <p>
              The booking page says whether parts are included in the price or
              quoted separately. Where they are quoted, the price is the labour
              and the business sends you a price for the part in your messages
              once they can see what is needed; nothing is fitted until you
              approve it.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Take the card at face value</h3>
            <p>
              A business is shown with a rating, a review and a count of
              completed jobs only where it has them. There is no placeholder
              for a business that has none — no stars greyed out, no "new" —
              because at scanning speed a placeholder is indistinguishable from
              a fact.
            </p>
            <p>
              Nothing on a business's page is verified by us. A licence or an
              insurance detail is what that business says about itself, and the
              issuing board's public register is the place to check one — so
              nothing here should be read as Round The Way vouching for anybody.
            </p>
          </div>
          <div className="tr-driver">
            <h3>Check who turns up</h3>
            <p>
              The business's vehicle details are shown to you in the app and the
              vehicle at your door has to match them. You give them a start code
              when they arrive, you both confirm the arrival, and photographs
              are taken before the work starts, while it is going on, and after
              it is finished.
            </p>
          </div>
        </div>
      </section>

      {/* --- the questions this page gets ------------------------------- */}
      <section className="tr-sec" aria-labelledby="cg-faq">
        <h2 id="cg-faq">Questions about what {lower} costs</h2>
        <p className="tr-sec-sub">
          Where these figures come from, and what you are actually paying for.
        </p>
        <div className="tr-faq">
          {faqs.map((f) => (
            <details className="tr-q" key={f.q}>
              <summary>{f.q}</summary>
              <p className="tr-a">{f.a}</p>
            </details>
          ))}
        </div>

        {/*
          The same six answers, for a search engine. The trade page has
          carried this since it was written and this one emitted nothing,
          which on the page most likely to be found by somebody typing "what
          does X cost" was the wrong way round. Built from the array above so
          the two can never come to say different things.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLd({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqs.map((f) => ({
                '@type': 'Question',
                name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            }),
          }}
        />
      </section>

      {/* --- how the figures were arrived at ----------------------------
          THE METHOD, WRITTEN OUT.

          The reference marketplace closes its cost guides with "How do we know
          these prices?", and it is the right block to have: a page of numbers
          that never says where they came from is asking to be trusted on its
          typography. Theirs answers it with a survey of jobs booked through
          them. Ours cannot and does not — every sentence below describes the
          arithmetic three hundred lines up in this file, and every figure in it
          is one this render counted.

          WHAT MUST NEVER APPEAR HERE. A national average, a typical cost, a
          "most people pay", or any figure standing in for the trade at large.
          The page's whole claim is that it counts what is listed and refuses to
          estimate what is not, and a method section is exactly where somebody
          would be tempted to smuggle one in as context. The third column below
          exists to say plainly that this page does not have one — that is the
          honest answer, and it is more useful than a number nobody measured. */}
      {stats.n > 0 && currency && (
        <section className="tr-sec" aria-labelledby="cg-method">
          <h2 id="cg-method">How we worked these figures out</h2>
          <p className="tr-sec-sub">
            There is no survey behind this page and no editor. Here is the whole
            method, and what it is and is not good for.
          </p>
          <div className="tr-drivers">
            <div className="tr-driver">
              <h3>Where the numbers come from</h3>
              <p>
                Every figure above is a price a business on Round The Way set on an
                appointment it has free right now. When you opened this page we
                read {stats.n} of them, listed by {stats.businesses}{' '}
                {stats.businesses === 1 ? 'business' : 'businesses'} under{' '}
                {services.length}{' '}
                {services.length === 1 ? 'job name' : 'different job names'}
                {located ? `, counting only businesses that can reach ${near}` : ''}.
                Nothing is stored or carried over: open it again tomorrow and a
                business that has since filled its Tuesday is no longer in the
                count.
              </p>
              {/* The one piece of arithmetic on this page that is not simply a
                  minimum or a maximum, so it is the one that has to be spelled
                  out. Calling a median an average is how a single very large
                  job ends up quietly describing a whole trade. */}
              {stats.mid !== null && stats.n >= ENOUGH && (
                <p>
                  The middle figure is the median: line all {stats.n} prices up
                  in order and it is the one in the centre, or the midpoint of
                  the two in the centre when there is an even number of them. It
                  is not an average, which one unusually big job would drag.
                </p>
              )}
              {/* A business's whole free day is genuinely available in every
                  neighbourhood it covers, so the map offers it in all of them.
                  Anyone checking these counts against the listing page needs to
                  know which of the two things was counted. */}
              <p>
                A business that covers five neighbourhoods offers the same free
                hour in all five, and this page counts that hour once.
              </p>
              {stats.samples > 0 && (
                <p>
                  {stats.samples === stats.n
                    ? (stats.n === 1
                      ? 'The one listing behind these figures is a sample'
                      : `All ${stats.n} listings behind these figures are samples`)
                    : `${stats.samples} of the ${stats.n} listings behind these figures ${
                      stats.samples === 1 ? 'is a sample' : 'are samples'}`}
                  {' '}we seeded ourselves so the map is not blank, rather than a
                  business trading today.
                </p>
              )}
            </div>
            <div className="tr-driver">
              <h3>What that tells you</h3>
              <p>
                What this work is being asked for on this site today, by the
                people who would do it. Every price above is attached to a
                particular hour of a particular business's week, which is why
                the cheapest of them has a link straight to it rather than a
                phone number.
              </p>
              {/* Only where the rows can carry the claim. On a trade where no
                  job name is listed twice there is no spread to point at, and
                  the sentence would be describing a table the reader can see
                  does not contain it. */}
              {evidence.differing > 0 && (
                <p>
                  And where two businesses list the same job name, it tells you
                  how far apart they are on it: {evidence.differing}{' '}
                  {evidence.differing === 1 ? 'job name' : 'job names'} in the
                  table above{' '}
                  {evidence.differing === 1 ? 'is' : 'are'} listed by more than
                  one business at more than one price.
                </p>
              )}
            </div>
            <div className="tr-driver">
              <h3>What it does not tell you</h3>
              <p>
                What {lower} costs in general. {stats.n}{' '}
                {stats.n === 1 ? 'listing' : 'listings'} from {stats.businesses}{' '}
                {stats.businesses === 1 ? 'business' : 'businesses'} is not the
                trade — it is the part of the trade that is on Round The Way and has
                an hour free this week.
              </p>
              <p>
                So there is no typical price on this page and no average for the
                work at large, because we have not measured one and we are not
                going to guess. If that is the figure you came for, this is not
                the page that has it.
              </p>
              <p>
                A listed price is also what the business is asking for the
                labour, not necessarily the final bill: where a job needs a part
                that has to be seen first, that price is quoted to you
                separately and nothing is fitted until you approve it.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* --- back to the listing, to a booking, and out to the map -------
          The two cross-links have always been here; what is new is the
          neighbourhood list under them, which is the thing a page called "what
          does X cost" most obviously owes the reader — a way through to the
          same trade somewhere they can name. Every one of those links goes to
          a page that has something on it, because a neighbourhood is only on
          the list if a row said an appointment is open in it. */}
      <section className="tr-sec" aria-labelledby="cg-near">
        <h2 id="cg-near">Find {lower} near you</h2>
        <p className="tr-sec-sub">
          {inTrade.length > 0
            ? 'The listing itself, and the neighbourhoods this trade is open in '
              + 'right now.'
            : 'Nothing is open in this trade at the moment, so there is one '
              + 'link here rather than a list of places with nothing in them.'}
        </p>

        <Link className="tr-cross" to={tradePageHref}>
          <span className="tr-cross-t">
            <b>{name} near you</b>
            <span>
              {inTrade.length > 0
                ? `${inTrade.length} ${inTrade.length === 1 ? 'appointment' : 'appointments'}`
                  + ' open right now, with the times and the businesses.'
                : 'The listing page for this trade, and the alert if nothing is open.'}
            </span>
          </span>
          <span className="tr-cross-go" aria-hidden="true">›</span>
        </Link>

        {bookable && currency && (
          <a className="tr-cross" href={`/book/${bookable.gap_id}`}>
            <span className="tr-cross-t">
              <b>Book the cheapest one: {money(bookable.price_cents, currency)}</b>
              <span>
                {bookable.service_name} with {bookable.business_name}, {bookable.when}.
                {/* Only when the two differ — that is, when a seeded listing is
                    undercutting every real one. Without it the summary box
                    above reports a lower "cheapest open right now" than this
                    link charges, and the reader is left to work out which of
                    the two numbers on one page is lying to them. It is the
                    same sentence in src/lib/seo.ts. */}
                {cheapest && cheapest.gap_id !== bookable.gap_id && (
                  <> The cheapest listing on this page is a sample, so this is
                    the cheapest one that can be booked.</>
                )}
              </span>
            </span>
            <span className="tr-cross-go" aria-hidden="true">›</span>
          </a>
        )}

        {openWhere.length > 0 && (
          <>
            <h3 className="tr-sub-h">
              {openWhere.length === 1
                ? 'The neighbourhood it is open in'
                : `The ${openWhere.length} neighbourhoods it is open in`}
            </h3>
            {/* Plain anchors, not <Link>s: everything under /near is rendered
                by the Worker and is not a React route, so a client-side
                navigation would land on the SPA's catch-all. `nearTradeHref`
                is what mints the spelling the Worker actually answers to;
                Trade.tsx and Areas.tsx build the same links from it. */}
            <ul className="tr-tiles">
              {openWhere.map((a) => (
                <li key={a.slug}>
                  <a href={nearTradeHref(a.slug, slug)}>
                    <span className="tr-tile-name">{a.name}</span>
                    <span className="tr-tile-n">
                      {a.n} {a.n === 1 ? 'appointment' : 'appointments'}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="tr-sec-foot">
              <a href="/near">Every neighbourhood Round The Way covers</a><MetroLinks />
            </p>
          </>
        )}
      </section>

      {/* --- how booking one works ---------------------------------------
          Their "How it works" band, with our facts in it. Three steps, each
          one something the product does today, and the third says plainly
          which half of paying is built and which is not — the same sentence
          PaymentState hands every other page, so a reader comparing this with
          the checkout finds one story rather than two. */}
      <section className="tr-sec" aria-labelledby="cg-how">
        <h2 id="cg-how">How booking one works</h2>
        <p className="tr-sec-sub">
          Three steps, and nothing between them that needs a phone call.
        </p>
        <ol className="tr-steps">
          <li>
            <h3>Find an hour that is already free</h3>
            <span>
              Every listing on Round The Way is unbooked working time — a job that
              cancelled, or a day that did not fill. You are choosing a
              particular hour from a particular business, not asking around for
              quotes.
            </span>
          </li>
          <li>
            <h3>Book it, and it is held</h3>
            {/* This band says nothing about money on purpose. What the site
                claims about paying is one answer in the FAQ above, taken from
                PaymentState so that every surface says it in the same words; a
                second telling of it here is how a page ends up with two
                versions of one promise. */}
            <span>
              The hour comes off that business's day the moment you book it and
              stops being offered to anybody else. What happens about money is
              answered in the questions above.
            </span>
          </li>
          <li>
            <h3>They arrive, and the work is recorded</h3>
            <span>
              The vehicle at your door has to match the details you were shown,
              you give them a start code, and photographs are taken before,
              during and after the work.
            </span>
          </li>
        </ol>
      </section>

      {/* --- other cost guides ------------------------------------------- */}
      {related.length > 0 && (
        <section className="tr-sec" aria-labelledby="cg-guides">
          <h2 id="cg-guides">Other cost guides</h2>
          <p className="tr-sec-sub">
            {placeInCatalog
              ? `The rest of ${placeInCatalog.category.label.toLowerCase()}, `
                + 'priced the same way this page is.'
              : 'The trades with the most listed on Round The Way right now, priced '
                + 'the same way this page is.'}
            {' '}
            Each one counts its own figures off the businesses on Round The Way the
            moment you open it.
          </p>
          <ul className="tr-tiles">
            {related.map((t) => (
              <li key={t.slug}>
                <Link to={costHref(t.slug)}>
                  <span className="tr-tile-name">What {t.label.toLowerCase()} costs</span>
                  <span className="tr-tile-n">
                    {t.n > 0
                      ? `${t.n} ${t.n === 1 ? 'price' : 'prices'} listed`
                      : 'nothing listed today'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="tr-sec-foot">
            <Link to="/cost">Every cost guide on Round The Way</Link>
          </p>
        </section>
      )}

      <footer className="tr-foot">
        <p>
          Every price on this page was listed by the business that would do
          the work, and counted at the moment the page loaded. It is what they
          are asking today, not an average of the trade.
        </p>
        <p>
          <Link to={tradePageHref}>{name}</Link>
          {placeInCatalog && (
            <>
              {' · '}
              <Link to={`/browse/${placeInCatalog.category.key}`}>
                {placeInCatalog.category.label}
              </Link>
            </>
          )}
          {' · '}
          <Link to="/cost">Every cost guide</Link>
          {' · '}
          <Link to="/">All trades</Link>
        </p>
      </footer>
    </PublicPage>
  );
}

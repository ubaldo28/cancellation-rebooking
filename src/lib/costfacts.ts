/**
 * WHAT ACTUALLY DRIVES THE BILL IN EACH TRADE - the one written table both
 * trees read.
 *
 * The cost guide is rendered twice: by web/src/pages/CostGuide.tsx for a
 * visitor with JavaScript, and by src/lib/seo.ts for a crawler and for a
 * visitor without it. Everything else on that page is counted from rows
 * fetched in the request, so the two halves cannot easily disagree. THIS is
 * the one part of it that is written down, which makes it the one part that
 * could - and it is several thousand words long, so a divergence would be
 * invisible to anybody reading either page on its own.
 *
 * IT LIVES HERE RATHER THAN INSIDE THE PAGE THAT USED TO HOLD IT. The Worker
 * cannot import out of web/, and web/tsconfig.json compiles web/src alone, so
 * the two builds cannot literally share a module today. What this file can do
 * is be the single place the Worker reads, and the obvious place the app copy
 * moves to the moment that build is widened. Until then the two copies are
 * pinned character for character by test/two-trees.test.ts, so the drift -
 * which is the actual defect - fails a test rather than shipping.
 *
 * THE RULES THE ENTRIES BELOW KEEP, restated here because they are the whole
 * reason a written table is allowed on a page whose argument is that it
 * counts:
 *
 *   1. Nothing here carries a number. Not a price, not a percentage, not
 *      "adds about a third". A written figure is exactly the invented average
 *      these pages exist to refuse, and it would sit two sections below
 *      figures that were genuinely counted, where nothing in the typography
 *      tells a reader which is which.
 *   2. Nothing here is a claim about the businesses on this site - not their
 *      training, not their equipment, not their insurance. These entries
 *      describe the work, not the people we list.
 *   3. A trade with no entry gets no section. The lookup at the foot returns
 *      nothing for the trades where the "price" is the price of goods rather
 *      than of work, and the sections are simply not drawn. Writing a vague
 *      paragraph to fill the hole is how a page ends up padded with things
 *      nobody checked.
 *
 * Keyed by the catalogue slug, which is the stored value on the operator row
 * and never changes once shipped - so a friendlier label can be reworded in
 * src/lib/trades.ts without silently detaching a trade from its own guide.
 *
 * The interface and every entry below are copied verbatim from
 * web/src/pages/CostGuide.tsx. Edit one and the pin fails; edit both.
 */

export interface TradeCosts {
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

export const TRADE_COSTS: Record<string, TradeCosts> = {
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
export const costsFor = (slug: string): TradeCosts | null => TRADE_COSTS[slug] ?? null;

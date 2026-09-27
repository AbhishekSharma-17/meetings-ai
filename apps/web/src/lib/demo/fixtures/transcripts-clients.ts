import type { Line } from "./transcript-kit";

const ALEX = "Alex Morgan", PRIYA = "Priya Shah", SOFIA = "Sofia Alvarez", MARCUS = "Marcus Reed", DANIEL = "Daniel Kim";
const OMAR = "Omar Haddad", NINA = "Nina Brooks", RAJ = "Raj Mehta";
const MARIA = "Maria Rossi", LENA = "Lena Fischer", TOM = "Tom Becker";

/** Two days ago: Initech support automation discovery. */
export const initechDiscovery: Line[] = [
  [ALEX, "Thanks for having us. We'd like to understand how support works at Initech today and where automation could help, before we propose anything."],
  [OMAR, "Happy to. The short version: ticket volume grew forty percent this year and headcount didn't. We need to do more with the same team."],
  [NINA, "We handle about eighteen thousand tickets a month in Zendesk, in English and Spanish. Roughly forty percent are billing questions and password resets."],
  [SOFIA, "How are those resolved today? Macros, or agents writing answers from scratch?"],
  [RAJ, "Macros for the simple ones, but the help center articles are out of date, so agents rewrite a lot. First response time is about nine hours right now."],
  [NINA, "And CSAT dropped from eighty-eight to eighty-two percent in two quarters. That's what the leadership team is watching."],
  [ALEX, "Is the goal to deflect tickets with a customer-facing bot, or to make agents faster?"],
  [OMAR, "Honestly, I'm nervous about a bot talking to customers about billing. One wrong answer about a refund and we're on social media."],
  [NINA, "I agree. Our agents would rather have a copilot that drafts the reply and shows where the answer came from."],
  [ALEX, "Then I'd suggest we start with agent assist, not deflection. Agents stay in control and we can measure time saved per ticket."],
  [OMAR, "That's the direction I'd approve. Let's decide that now: agent assist first, no customer-facing bot this year."],
  [SOFIA, "For the drafts to be good, we need the resolved tickets and the billing policy documents. Can we get a twelve-month export?"],
  [RAJ, "I can export from Zendesk, but it includes customer emails and card fragments. We'd need to scrub those."],
  [SOFIA, "We have a redaction step we run before indexing. We'd show you a sample before anything is processed."],
  [NINA, "Which queue would you start with? Billing is the biggest, but it's also the riskiest."],
  [ALEX, "Billing, precisely because it's measurable. We'd keep a human approving every draft, so the risk stays with your agents."],
  [OMAR, "What does success look like in numbers? I'll need that for the business case."],
  [ALEX, "I'd propose three: first response time down by at least thirty percent on the billing queue, handle time down twenty percent, and CSAT back above eighty-five."],
  [NINA, "Those are ambitious but fair. Spanish needs to be in scope from day one, though. A third of billing tickets are Spanish."],
  [SOFIA, "The models handle Spanish well. We'd want one of your bilingual agents to help build the evaluation set."],
  [RAJ, "Maria Lopez on my team could do that. She's our Spanish queue lead."],
  [OMAR, "Budget-wise, I can fund a pilot this quarter if it's under fifty thousand. Anything bigger goes to the steering committee in January."],
  [ALEX, "Understood. We'll scope the pilot to fit, with a clear go or no-go at the end."],
  [NINA, "When would you need the export?"],
  [SOFIA, "Within two weeks would let us show a working prototype at the scoping workshop."],
  [RAJ, "I'll have the redacted sample by next Wednesday and the full export the week after."],
  [ALEX, "Perfect. We'll send a summary, the data request and a draft pilot plan by Friday. Thanks, everyone."],
];

/** Three days ago: Globex managed-service renewal. */
export const globexRenewal: Line[] = [
  [PRIYA, "Thanks for joining. We're here to agree the renewal of the managed service for the invoice automation platform, which ends on December thirty-first."],
  [MARIA, "Thank you. Overall we're happy with the service, but our leadership asked me to push on two things: the SLA and the price."],
  [PRIYA, "Let's take the SLA first. You're on ninety-nine point five percent availability today."],
  [MARIA, "We'd like ninety-nine point nine. The platform now processes all European invoices, so downtime at month-end is very visible."],
  [ALEX, "We can offer ninety-nine point nine for month-end close, the last three business days, and keep ninety-nine point five for the rest of the month."],
  [MARIA, "That's creative. What about response times? A P1 today is a four-hour response."],
  [PRIYA, "We can move P1 to one hour, around the clock, if we add a second on-call engineer. That's part of the cost discussion."],
  [LENA, "From legal: whatever we agree, the service credits need to scale with the new SLA. Today they're capped at five percent."],
  [ALEX, "We can raise the cap to ten percent for month-end breaches. That keeps the incentive where you care most."],
  [MARIA, "Now the price. Your proposal says six percent increase. Our target was flat."],
  [MARCUS, "The six percent reflects the second on-call engineer and the higher volumes. Invoice volume is up sixty percent since we started."],
  [MARIA, "I understand, but a flat renewal is easier internally. What if we commit to a longer term?"],
  [MARCUS, "With a two-year term we could do four percent in year one and hold it flat in year two."],
  [MARIA, "Four percent over two years with the improved SLA. I think I can sell that."],
  [ALEX, "Then let's agree it in principle: two-year term, four percent in year one, flat in year two, month-end SLA at ninety-nine point nine, P1 response in one hour."],
  [MARIA, "Agreed in principle, subject to Lena's review of the paper."],
  [LENA, "One more item: the data processing addendum needs updating for the new sub-processor you added in the spring."],
  [PRIYA, "Yes, the monitoring vendor. We'll send the updated DPA with the renewal paper."],
  [LENA, "And I need the renewal signed before December first so it goes through our Q4 approval cycle."],
  [MARCUS, "We'll send the draft order form and the DPA by next Tuesday."],
  [MARIA, "Also, can your team present the month-end performance report at our QBR? It helps me justify the spend."],
  [PRIYA, "Of course. I'll prepare it and send it a week before the QBR."],
  [MARIA, "Is there a way to reduce the cost of the second engineer if volumes drop next year?"],
  [ALEX, "We can add a volume review at month eighteen. If volumes fall by more than twenty percent, we revisit staffing and price."],
];

/** Six days ago: Globex invoice automation go-live review; recap already sent. */
export const globexGoLive: Line[] = [
  [DANIEL, "Welcome everyone. This is the go-live review for the invoice automation rollout to the Italian and Spanish entities."],
  [TOM, "Thanks. From IT the cut-over went smoothly. We switched the mailbox routing on Monday and nothing was lost."],
  [DANIEL, "In the first week we processed about four thousand two hundred invoices. Straight-through processing was seventy-eight percent."],
  [MARIA, "What was the target again?"],
  [DANIEL, "Seventy-five percent for the first month, eighty-five percent by the end of the quarter."],
  [MARIA, "So we're ahead. What's in the twenty-two percent that needed a human?"],
  [SOFIA, "Mostly two things: supplier invoices with handwritten corrections, and Spanish invoices with the tax ID in a non-standard position."],
  [TOM, "The Spanish issue should be fixable. It's six suppliers who use an old template."],
  [SOFIA, "Yes. We've added those templates to the training set and expect the rate to go up by about five points next week."],
  [MARIA, "And the handwritten ones?"],
  [DANIEL, "Those will stay manual for now. It's under two percent of volume and the accuracy isn't good enough to automate safely."],
  [MARIA, "I agree, keep those manual. I'd rather have a person look at them."],
  [TOM, "One incident to note: on Wednesday the ERP API was slow for forty minutes, and the queue backed up."],
  [DANIEL, "The platform retried automatically and nothing was lost, but we'll add an alert when the queue is older than fifteen minutes."],
  [TOM, "Please send that alert to our IT on-call as well, not just yours."],
  [DANIEL, "Will do. We'll route it to both teams."],
  [MARIA, "Then from my side the rollout is accepted. Please send the recap to the finance leads in Milan and Madrid."],
  [DANIEL, "We'll send the approved recap today, including the straight-through processing numbers."],
  [SOFIA, "We'll also share a short weekly report for the rest of the quarter so the trend is visible."],
  [MARIA, "Perfect. Thanks, team. Good work."],
];

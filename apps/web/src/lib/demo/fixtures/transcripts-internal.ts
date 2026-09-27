import type { Line } from "./transcript-kit";

const ALEX = "Alex Morgan", PRIYA = "Priya Shah", DANIEL = "Daniel Kim", SOFIA = "Sofia Alvarez", MARCUS = "Marcus Reed";

/** Four days ago: internal leadership sync; minutes approved, not sent. */
export const leadershipSync: Line[] = [
  [ALEX, "Morning. Pipeline, delivery, hiring, then Marcus on the numbers. Priya, pipeline first?"],
  [PRIYA, "Three live opportunities. Acme Robotics is the biggest: the FieldGuide pilot is scoped for October fourteenth, and the Rotterdam MOU could turn it into a multi-site deal."],
  [PRIYA, "Initech is at discovery. Omar signalled budget under fifty thousand for a pilot this quarter. And the Globex renewal is being negotiated this week."],
  [ALEX, "What's the risk on Globex?"],
  [PRIYA, "Price. They want flat. I think a two-year term with a small increase gets us there."],
  [MARCUS, "Anything under four percent and the second on-call engineer isn't covered. Four is the floor."],
  [ALEX, "Then four is our floor. Let's agree that now so nobody improvises on the call."],
  [DANIEL, "Delivery: the Globex go-live is done and ahead of target. The Acme architecture doc is drafted; I'll finish the data map this week."],
  [SOFIA, "On my side, the evaluation harness is ready to reuse. For Acme I want to add a red-team set for prompt injection from ticket text."],
  [ALEX, "Good. That's a differentiator, put it in the proposal as standard."],
  [DANIEL, "One concern: if Acme and Initech both start in October, I'm on both, and utilisation is already at seventy-eight percent."],
  [PRIYA, "That's why Hannah matters. She accepted the offer and starts on the first of next month."],
  [ALEX, "Great news. Hannah shadows Daniel on Acme for two weeks, then takes the day-to-day on Initech."],
  [DANIEL, "That works if she's in the Initech scoping workshop. Can we invite her?"],
  [PRIYA, "I'll add her to the invite and send her the discovery minutes."],
  [MARCUS, "Numbers: we're at eighty-one percent of the Q4 revenue target with the pipeline weighted. Cash is fine. Tooling spend on AI APIs is up, mostly from meeting prep research."],
  [ALEX, "Is it material?"],
  [MARCUS, "Not yet. About sixty dollars a month in model and search costs. I'll keep an eye on it in Observability."],
  [SOFIA, "We could switch prep research to the cheaper model for the planning step. Quality barely changes."],
  [ALEX, "Try it for two weeks and compare. Anything else? No? Then decisions are: Globex floor at four percent, Hannah on Acme then Initech, and the red-team set becomes standard."],
  [PRIYA, "I'll circulate the minutes after approval."],
  [ALEX, "Thanks all."],
];

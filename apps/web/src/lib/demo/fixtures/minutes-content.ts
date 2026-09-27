import type { MinutesDraft } from "../../types";
import type { MinutesKey } from "./meetings";
import { evidence as ev } from "./transcript-kit";

/** Short human due dates relative to the demo clock, e.g. "Oct 3". */
export type DueDate = (days: number) => string;

export function minutesContent(key: MinutesKey, due: DueDate): MinutesDraft {
  switch (key) {
    case "roadmap": {
      const k = "acme-roadmap";
      return {
        title: "Acme Robotics — Q4 automation roadmap",
        executive_summary: "Acme Robotics and Northwind Labs agreed a four-week FieldGuide pilot for the R7 picker across the Austin and Reno sites, starting October 14 with a readout on November 4. The pilot runs entirely inside Acme's Azure tenant. Success is measured on time to repair and first-time fix rate; Dutch manuals for Rotterdam and production pricing remain open.",
        discussion_points: [
          "The Port of Rotterdam MOU increases pressure to scale maintenance with the new fleet.",
          "Technicians spend about a third of a 90-minute repair finding the right procedure across roughly 4,000 PDFs.",
          "Deployment must stay inside Acme's Azure tenant using Acme's own model deployment.",
          "Offline access for low-connectivity areas at Reno was raised and kept out of pilot scope.",
          "Acme expects an evaluation report showing failure cases, not only a demo.",
        ],
        decisions: [
          "Run the pilot on the R7 picker only: two sites, five technicians, four weeks.",
          "Pilot starts October 14 with a readout on November 4, subject to data access by October 10.",
          "The pilot is fixed price; the SOW includes an indicative production price range per site.",
        ],
        action_items: [
          { description: "Send the architecture document and data map", owner: "Daniel Kim", due_date: due(3), evidence_segment_ids: ev(k, 20, 21) },
          { description: "Grant read access to the SharePoint maintenance library", owner: "Asha Patel", due_date: due(4), evidence_segment_ids: ev(k, 19) },
          { description: "Nominate five pilot technicians and confirm tablets", owner: "Chen Li", due_date: due(5), evidence_segment_ids: ev(k, 22) },
          { description: "Send the statement of work with success criteria and a per-site production range", owner: "Priya Shah", due_date: due(6), evidence_segment_ids: ev(k, 26, 30) },
        ],
        open_questions: [
          "Should Dutch-language manuals for the Rotterdam yard trucks be included, and when?",
          "What will production cost per site after the pilot?",
        ],
        speaker_contributions: [
          { speaker: "Asha Patel", summary: "Set the tenant and security constraints, committed to the October pilot and asked for an evaluation report.", evidence_segment_ids: ev(k, 8, 17, 31) },
          { speaker: "Chen Li", summary: "Quantified the repair-time problem and supported the 20% improvement target.", evidence_segment_ids: ev(k, 4, 6, 16) },
          { speaker: "Alex Morgan", summary: "Proposed the smallest viable pilot and the evaluation approach.", evidence_segment_ids: ev(k, 15, 32) },
          { speaker: "Priya Shah", summary: "Set the timeline and commercial approach.", evidence_segment_ids: ev(k, 18, 26) },
        ],
        questions_asked: [
          { speaker: null, question: "Will it work offline on the Reno floor?", evidence_segment_ids: ev(k, 10) },
          { speaker: "Asha Patel", question: "What happens with production pricing after the pilot?", evidence_segment_ids: ev(k, 27) },
        ],
      };
    }
    case "discovery": {
      const k = "initech-discovery";
      return {
        title: "Initech — support automation discovery",
        executive_summary: "Initech's support team handles about 18,000 tickets a month in English and Spanish, with first response times near nine hours and CSAT down to 82%. The group decided to start with agent assist on the billing queue rather than a customer-facing bot. A pilot under $50k is fundable this quarter.",
        discussion_points: [
          "Ticket volume grew 40% this year without new headcount; 40% of tickets are billing or password questions.",
          "Help center articles are out of date, so agents rewrite macro answers.",
          "Leadership is concerned about a bot giving wrong billing or refund answers to customers.",
          "Spanish must be in scope from day one; a third of billing tickets are Spanish.",
        ],
        decisions: [
          "Start with agent assist (drafted replies with sources), not customer-facing deflection this year.",
          "Pilot on the billing queue with a human approving every draft.",
        ],
        action_items: [
          { description: "Export a redacted sample of 12 months of Zendesk tickets", owner: "Raj Mehta", due_date: due(5), evidence_segment_ids: ev(k, 26) },
          { description: "Send summary, data request and draft pilot plan", owner: "Alex Morgan", due_date: due(2), evidence_segment_ids: ev(k, 27) },
          { description: "Nominate a bilingual agent to build the Spanish evaluation set", owner: "Raj Mehta", due_date: null, evidence_segment_ids: ev(k, 20, 21) },
        ],
        open_questions: ["Can the full export arrive in time for a prototype at the scoping workshop?"],
        speaker_contributions: [
          { speaker: "Omar Haddad", summary: "Framed the business problem, ruled out a customer-facing bot and set the budget limit.", evidence_segment_ids: ev(k, 2, 11, 22) },
          { speaker: "Nina Brooks", summary: "Described volumes, CSAT decline and the need for Spanish support.", evidence_segment_ids: ev(k, 3, 6, 19) },
          { speaker: "Raj Mehta", summary: "Explained the macro workflow and committed to the data export.", evidence_segment_ids: ev(k, 5, 26) },
        ],
        questions_asked: [
          { speaker: "Omar Haddad", question: "What does success look like in numbers?", evidence_segment_ids: ev(k, 17) },
          { speaker: "Nina Brooks", question: "Which queue would you start with?", evidence_segment_ids: ev(k, 15) },
        ],
      };
    }
    case "renewal": {
      const k = "globex-renewal";
      return {
        title: "Globex — contract renewal and SLA review",
        executive_summary: "Globex and Northwind Labs agreed in principle to a two-year renewal of the invoice automation managed service: 4% increase in year one and flat in year two, 99.9% availability during month-end close and a one-hour P1 response. Legal review and an updated DPA are pending, with signature needed before December 1.",
        discussion_points: [
          "Globex asked for 99.9% availability because the platform now processes all European invoices.",
          "A one-hour P1 response requires a second on-call engineer.",
          "Invoice volume is up 60% since the start of the contract.",
        ],
        decisions: [
          "Two-year term: 4% increase in year one, flat in year two.",
          "Availability of 99.9% during month-end close (last three business days), 99.5% otherwise.",
          "P1 response within one hour, around the clock; service credit cap raised to 10% for month-end breaches.",
        ],
        action_items: [
          { description: "Send the draft order form and updated DPA", owner: "Marcus Reed", due_date: due(3), evidence_segment_ids: ev(k, 18, 20) },
          { description: "Prepare the month-end performance report for the Globex QBR", owner: "Priya Shah", due_date: due(14), evidence_segment_ids: ev(k, 22) },
          { description: "Review the renewal paper and DPA", owner: "Lena Fischer", due_date: due(10), evidence_segment_ids: ev(k, 16, 19) },
        ],
        open_questions: ["How will staffing and price change if volumes fall by more than 20%? (Volume review at month 18.)"],
        speaker_contributions: [
          { speaker: "Maria Rossi", summary: "Negotiated SLA and price; accepted the two-year structure in principle.", evidence_segment_ids: ev(k, 4, 12, 14) },
          { speaker: "Marcus Reed", summary: "Explained the cost basis and proposed the two-year pricing.", evidence_segment_ids: ev(k, 11, 13) },
          { speaker: "Lena Fischer", summary: "Raised service credits, the DPA update and the signature deadline.", evidence_segment_ids: ev(k, 8, 17, 19) },
        ],
        questions_asked: [{ speaker: "Maria Rossi", question: "Is there a way to reduce the cost of the second engineer if volumes drop?", evidence_segment_ids: ev(k, 23) }],
      };
    }
    case "leadership": {
      const k = "leadership";
      return {
        title: "Northwind Labs — weekly leadership sync",
        executive_summary: "Pipeline is healthy at 81% of the Q4 target (weighted). The team set a 4% floor for the Globex renewal, planned Hannah Lee's onboarding across Acme and Initech, and made the prompt-injection red-team set a standard part of every evaluation.",
        discussion_points: ["Acme pilot scoped; Initech in discovery; Globex renewal in negotiation.", "Delivery utilisation at 78%; Hannah Lee starts next month.", "AI API spend is rising slightly because of meeting prep research."],
        decisions: ["Globex renewal floor is a 4% increase.", "Hannah shadows Daniel on Acme for two weeks, then leads Initech day to day.", "The red-team evaluation set becomes standard in proposals."],
        action_items: [
          { description: "Add Hannah to the Initech scoping workshop and share discovery minutes", owner: "Priya Shah", due_date: due(-2), evidence_segment_ids: ev(k, 15) },
          { description: "Trial a cheaper model for the prep planning step and compare quality", owner: "Sofia Alvarez", due_date: due(10), evidence_segment_ids: ev(k, 19, 20) },
          { description: "Track AI API spend in Observability", owner: "Marcus Reed", due_date: null, evidence_segment_ids: ev(k, 18) },
        ],
        open_questions: [],
        speaker_contributions: [
          { speaker: "Priya Shah", summary: "Reported pipeline and the Hannah Lee hire.", evidence_segment_ids: ev(k, 2, 3, 12) },
          { speaker: "Marcus Reed", summary: "Set the pricing floor and reported financials.", evidence_segment_ids: ev(k, 6, 16) },
        ],
        questions_asked: [{ speaker: "Alex Morgan", question: "What's the risk on Globex?", evidence_segment_ids: ev(k, 4) }],
      };
    }
    case "golive": {
      const k = "globex-golive";
      return {
        title: "Globex — invoice automation go-live review",
        executive_summary: "The rollout to Globex's Italian and Spanish entities went live without data loss. First-week straight-through processing reached 78% against a 75% target. Globex accepted the rollout; handwritten invoices remain manual and a queue-age alert will be added for both teams.",
        discussion_points: ["About 4,200 invoices processed in week one.", "Exceptions come from handwritten corrections and six Spanish suppliers using an old template.", "A 40-minute ERP API slowdown backed up the queue; retries prevented loss."],
        decisions: ["Rollout accepted by Globex.", "Invoices with handwritten corrections stay manual.", "Queue-age alerts go to both Northwind and Globex IT on-call."],
        action_items: [
          { description: "Add the six Spanish supplier templates to training", owner: "Sofia Alvarez", due_date: due(-3), evidence_segment_ids: ev(k, 9) },
          { description: "Add a queue-age alert (15 minutes) routed to both teams", owner: "Daniel Kim", due_date: due(-1), evidence_segment_ids: ev(k, 14, 16) },
          { description: "Share a weekly performance report for the rest of the quarter", owner: "Sofia Alvarez", due_date: null, evidence_segment_ids: ev(k, 19) },
        ],
        open_questions: [],
        speaker_contributions: [
          { speaker: "Daniel Kim", summary: "Presented results and the incident follow-up.", evidence_segment_ids: ev(k, 3, 11, 14) },
          { speaker: "Maria Rossi", summary: "Accepted the rollout and requested the recap for finance leads.", evidence_segment_ids: ev(k, 17) },
        ],
        questions_asked: [{ speaker: "Maria Rossi", question: "What's in the 22% that needed a human?", evidence_segment_ids: ev(k, 6) }],
      };
    }
    case "security": {
      const k = "acme-security";
      return {
        title: "Acme Robotics — security and data review",
        executive_summary: "Acme's security lead reviewed the FieldGuide pilot data flows. Everything runs in Acme's Azure tenant with a private Azure OpenAI endpoint, Entra ID sign-in, and query logs in Acme's Log Analytics workspace for 90 days. Approval of the ServiceNow export depends on a redacted sample and a current SOC 2 report.",
        discussion_points: ["West Europe hosting for Rotterdam; Central US for US sites.", "Tickets are redacted before indexing; only fault codes, resolutions, parts and asset model are kept.", "Prompt-injection risk from user-written ticket text."],
        decisions: ["Single sign-on through Entra ID restricted to an Acme-managed security group.", "Query logs retained for 90 days; the pilot index is deleted at pilot end unless moved to production."],
        action_items: [
          { description: "Send a redacted sample of 50 tickets for sign-off", owner: "Daniel Kim", due_date: due(-2), evidence_segment_ids: ev(k, 8, 9) },
          { description: "Share the SOC 2 Type II report under NDA", owner: "Daniel Kim", due_date: due(-1), evidence_segment_ids: ev(k, 18) },
          { description: "Add a red-team prompt-injection set to the evaluation plan", owner: "Sofia Alvarez", due_date: due(4), evidence_segment_ids: ev(k, 20, 21) },
        ],
        open_questions: ["Written deletion date for the pilot index."],
        speaker_contributions: [{ speaker: "Grace Liu", summary: "Set residency, logging, retention and red-team conditions.", evidence_segment_ids: ev(k, 2, 12, 16, 21) }],
        questions_asked: [{ speaker: "Asha Patel", question: "What's your incident process if something goes wrong?", evidence_segment_ids: ev(k, 17) }],
      };
    }
  }
}

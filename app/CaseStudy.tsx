import { EVAL, TOTAL as T } from './evalNumbers';

const REPO = 'https://github.com/Nakul532/rush-hour-lab';

export function CaseStudy() {
  const o = EVAL.original;
  const i = EVAL.interacting;
  const b = EVAL.builder;
  return (
    <article className="case">
      <h1>How Rush Hour Lab works, and what we learned building it</h1>

      <h2>The problem</h2>
      <p>Independent cafés lose customers to long morning-rush waits and can't afford a consultant. The owner's question is simple: what should I change, without hiring anyone or spending much, to cut waits? Rush Hour Lab answers it by simulating the rush and testing changes before anyone moves a single chair.</p>

      <h2>Data</h2>
      <ul>
        <li><strong>OBSERVED:</strong> 18 timed orders from one moderate-traffic session at a Bay Area café (9 drink only, 4 food only, 5 drink + food). The only real waits in the project.</li>
        <li><strong>PUBLISHED BENCHMARK:</strong> a coffee-shop queuing study (UTHM, M/M/1, average time in system 3.52 min), used to check the simulator, and City Observatory's order-placement times.</li>
        <li><strong>Reconstructed:</strong> Curio Coffee, from a 2025 class Lean proposal whose recommendations were not implemented. Its figures don't fit together (300 orders in two hours would need about 24 staff at its step times), so we read the step times as elapsed time including waiting and fitted one scale factor to the 8–12 min waits staff reported.</li>
      </ul>

      <h2>Method</h2>
      <ol>
        <li><strong>Simulator.</strong> A discrete-event model of one rush: random arrivals per 15 minutes, cashier → barista and/or kitchen → handoff, staff that can change during the rush. Tested against queueing theory (M/M/1 gives 3.52 min; Little's law holds exactly; the same seed gives identical results).</li>
        <li><strong>Calibration.</strong> Task times fitted to the 18 observed orders. Drink-only and food-only waits match; drink + food waits come out about 5.6 min short of the observed 17 min (three of those five orders may be one group order). Adding grab-and-go items raised leave-one-out coverage from 12 to 15 of 18.</li>
        <li><strong>Acceptance rule (code, not the AI's opinion).</strong> A change is recommended only if the bad-case (90th percentile) wait improves by at least 10%, the paired 95% confidence interval excludes zero, it still helps with every task 30% faster and 30% slower, no order type gets more than 10% worse, every order gets served, and time in the café (including the order line) gets no more than 10% worse. Every plan from every path first passes one shared validator (no station left without staff during the rush). The final pick is re-checked on a fresh simulation before it is shown.</li>
        <li><strong>Search.</strong> Code tests every combination of options (brute force) when that fits in about 20 seconds, and a step-by-step greedy search otherwise. An AI analyst (gpt-oss-120b) proposes and tests its own ideas in the same option space. Whichever passing plan is best is recommended, and the page says which method found it.</li>
      </ol>

      <h2>Evaluation: brute force vs greedy vs the AI agent</h2>
      <p>{T.scenarios} test cafés ({T.scenarios - 2} synthetic, plus the calibrated observed café and the reconstructed Curio café), each with a small enough option space ({T.plans.toLocaleString('en-US')} plans in all) that brute force finds the truly best plan. Scenarios and scoring were committed before any agent ran; later changes were committed as labelled addenda before they ran.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Best plan found</th><th>Brute force</th><th>Greedy search</th><th>AI agent</th></tr></thead>
          <tbody>
            <tr><td>15 original scenarios</td><td>15 of 15</td><td>{o.greedy.best} of 15</td><td>{o.agent.best} of 15 (clean re-run: {o.agentRerun.best})</td></tr>
            <tr><td>5 interacting-changes scenarios</td><td>5 of 5</td><td>{i.greedy.best} of 5</td><td>{i.agent.best} of 5</td></tr>
            <tr><td><strong>All {T.scenarios}</strong></td><td><strong>{T.scenarios} of {T.scenarios}</strong></td><td><strong>{T.greedyBest} of {T.scenarios}</strong></td><td><strong>{T.agentBest} of {T.scenarios}</strong></td></tr>
            <tr><td>Simulations used</td><td>{T.bruteSims.toLocaleString('en-US')}</td><td>{T.greedySims.toLocaleString('en-US')}</td><td>{T.agentSims.toLocaleString('en-US')}</td></tr>
          </tbody>
        </table>
      </div>
      <ul>
        <li><strong>Brute force</strong> is the ground truth and, at this size, cheap: every plan for a café in seconds in the browser.</li>
        <li><strong>Greedy search</strong> (try every single change, keep the best, repeat) solved all 15 original scenarios and the 3 interacting scenarios where each fix still helps a little on its own. It fell into both budget traps, where the best single change uses up the budget.</li>
        <li><strong>The AI agent never beat plain search.</strong> It used the fewest simulations but mostly stopped one or two changes short of the best combination, and fell into the same budget traps. Retrying its empty replies did not change a single outcome. So the product lets code search (brute force, or greedy when brute force would be too slow) and uses the AI to read café descriptions, answer what-if questions and propose extra ideas, which are tested and credited when they win.</li>
      </ul>

      <h2>Why every recommendation is re-checked</h2>
      <p>The search tests each plan on a modest number of simulated rushes. Near the 10% bar, that is noisy. When we re-ran every accepted plan on a fresh seed with five times the simulations, {o.falsePositives} of {o.accepted} failed on the original scenarios, but {i.falsePositives} of {i.accepted} did on the interacting ones. All of those were borderline: they passed at 10–13% and re-measured at 6–10%, still real improvements but under the bar. One was the AI agent's own recommendation in a test café. None was a best plan.</p>
      <p>So the app never shows a plan straight from the search. The best passing plan is re-run on 1,000 fresh simulated rushes against the full acceptance test; if it fails, the next best is tried. The results page labels the recommendation "verified" only after that, and its headline numbers come from the re-check run.</p>

      <h2>Turning descriptions into cafés</h2>
      <p>The AI reads a plain-English description into a café the owner checks before anything runs. On 10 test descriptions it got {b.before.pct}% of stated fields right at first; it kept dropping stated zeros like "no kitchen staff" or "drinks only". After fixing that, it scored {b.afterSeen.pct}% on those 10 descriptions, but they had been seen while writing the fix. The fair test is five new descriptions written and committed before the fix ran: <strong>{b.heldOut.pct}% ({b.heldOut.correct} of {b.heldOut.fields} fields), with {b.heldOut.invented} invented field</strong>.</p>

      <h2>Three times the metric could be gamed, and how each was caught</h2>
      <p>An optimizer, human or AI, finds the cheapest way to move the number it is judged by. Three times, the cheapest way was to stop the number seeing the problem.</p>
      <h3>1. An empty kitchen: orders that never finish don't count</h3>
      <p><em>Caught by an adversarial test of the acceptance rule, before any AI ran.</em> "Move the cook to the drinks station" passed every check with an 82% shorter bad-case wait at no cost. With nobody in the kitchen, food orders never finished, and the simulator only measured orders that did. Fix: the simulator reports unserved orders, the rule requires that every order is served, and plans that leave a station empty are refused.</p>
      <h3>2. An empty register: the same exploit by a different route</h3>
      <p><em>Caught when a test run hung while building this app.</em> The new search applied plans without the empty-station check the AI's input went through. Two moves off a two-person register, each fine alone, left nobody taking orders, and with batch cooking the simulator ran forever. Fix: one shared plan validator that every path uses (AI agent, what-if, greedy, brute force, the hybrid, the evaluation), checking every staffing window during the rush, with a regression test through each path; and a hard time limit in the simulator.</p>
      <h3>3. "Wait" starts at the till</h3>
      <p><em>Caught testing the app on the near-capacity Curio café with no new hires.</em> We measure wait from placing the order to receiving it, matching how the 18 real orders were timed. The app recommended moving a cashier to the kitchen: wait 66% shorter, every check passed, but time in the café went from 43 to 169 minutes because the order line grew without limit, outside the measured window. In the evaluation this had never happened ({EVAL.timeInCafe.worse} of {EVAL.timeInCafe.acceptedPlans} accepted plans made time in the café worse), because those cafés' registers had spare capacity. Fix: a seventh check, time in the café must not get more than 10% worse. Re-running all {T.scenarios} evaluation scenarios with it changed no result; on Curio the recommendation became parallel prep plus grab-and-go, and time in the café improved.</p>
      <h3>Also: mocked tests passed, the first live call failed</h3>
      <p>All 105 tests passed with a scripted AI. The first live run then sent the same incomplete change ten times: the tool schema declared only the change's kind, and the model followed the schema exactly. Fix: declare every field, return errors that name what is missing, and stop after three identical failures. The real responses are now a replay test.</p>

      <h2>Limitations</h2>
      <ul>
        <li>Calibrated on 18 orders from one session at one café. Staffing, arrival rate and several task times there are assumptions.</li>
        <li>18 of the 20 evaluation cafés are synthetic, their option spaces are small, and each AI configuration ran once per scenario (results vary between runs).</li>
        <li>Confidence intervals cover simulation noise only, not whether the model matches a real café.</li>
        <li>Costs are user-entered; the defaults are assumptions.</li>
        <li>Decision support, not a guarantee.</li>
      </ul>
      <p>Code, data provenance and full evaluation: <a href={REPO}>{REPO.replace('https://', '')}</a> (see calibration/REPORT.md and eval/README.md).</p>
    </article>
  );
}

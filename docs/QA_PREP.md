# FloodFund Karachi · judge Q&A

1. **Why does AIFS drive live funding instead of your models?** The team models post-process AIFS for a fixed UTC day. The funding workflow uses a rolling forecast window. The prior record reports the lowest validation and test MAE for raw AIFS, and its artifacts are unavailable for reproduction here.
2. **Why did no model detect the 80 mm day?** The prior record shows one reference exceedance and zero predicted exceedances per model. The available evidence does not establish why the event was missed.
3. **Is 80 mm validated?** It is a demonstration threshold. Local flood observations and municipal review would be needed to validate an operational threshold.
4. **Where do the PKR numbers come from?** The policy defines simulated allocation and budget amounts. C15 applies explicitly labeled assumptions for portfolio value, exposed share, damage, mitigation, and false-alarm cost to detection counts.
5. **Was drift detection tested on real drift?** The verdict cases are synthetic and the automated archived-data tests mock providers. Live monitoring cannot produce a verdict in this checkout because the original drift reference is absent.
6. **What does the guard miss?** Plausible but wrong forecasts can pass. Passing the guard establishes that configured checks passed, and provides no flood-skill guarantee.
7. **How do you prevent double funding?** A session row lock, a unique session/policy/event allocation constraint, and an atomic budget deduction protect repeat and concurrent checks.
8. **What if the provider fails?** The UI reports unavailable data, or unverified data if a stitched forecast can be shown without a pinned run. The funding rule blocks those statuses. The synthetic scenarios remain available if the app and database are reachable.
9. **Is any money real?** All allocations and budgets are simulated PostgreSQL records. No payment service is connected.
10. **What environmental impact can you claim?** The project demonstrates an adaptation-finance workflow. It measures no environmental benefit, real avoided losses, or money saved.
11. **What would you do with another month?** Restore the artifacts, validate the threshold with local flood records and the municipality, replace cost assumptions with municipal data, and add authentication and a production scheduler.
12. **How were train, validation, and test split?** The prior record describes a chronological split. Training ran 3 April–8 July, validation 9 July–9 August, and testing 10 August–14 September 2026. The dataset and original split code are absent here.
13. **What is the seasonality caveat for drift?** The prior dataset covers a single season. Changes in the day-of-year features outside the configured April–September window are flagged as seasonal and excluded from the overall warning and retraining counts.
14. **How do you handle small samples in KS and PSI?** The default minimum is 30 values per side. Smaller windows return insufficient data, KS p-values are approximate, and Bonferroni adjustment applies to the eight feature comparisons.
15. **What does exactly-once mean here, and how is it tested?** A qualifying session/policy/event has one allocation row and one simulated deduction. Tests repeat the storm, run eight concurrent evaluations, and verify the database constraint rejects duplicate rows.

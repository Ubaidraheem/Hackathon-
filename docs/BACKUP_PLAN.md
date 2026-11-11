# FloodFund Karachi · demo-day checklist

- [ ] Prefer a rehearsed production build. Run `npm run build` and then `npm run start`. Use `npm run dev` if that is the rehearsed environment. Check the printed port and open that dashboard.
- [ ] Check `/api/v1/health` for HTTP 200 and `database: "ok"`. Keep the local database connection private.
- [ ] Open a fresh browser profile or reset a dedicated demo session. Confirm PKR 2,000,000 and no current allocations. The browser stores the session ID in local storage under `floodfund.sessionId`, scoped to the site origin. **Reset session** restores the budget and retains audit history.
- [ ] Check the Karachi forecast status and run timestamp, then the NASA tile status. Report whatever status is actually shown.
- [ ] At 100% browser zoom, check that the budget, decision, and Run buttons are legible on the presentation display. Keep the Challenge scoreboard and README open in a second tab.
- [ ] Practice Severe storm twice, the two Guard examples, Stable distribution and Residual bias, and the Balanced and Aggressive C15 presets. Confirm the Measured and live drift unavailable messages if artifacts are still missing.
- [ ] Record a local **60-second screen clip** before the session. Spend about 15 seconds on the storm and repeated budget, 15 seconds on the guard rejection, 15 seconds on residual drift, and 15 seconds on the two C15 presets. Use the on-screen synthetic and assumption labels. Play the clip back and confirm the text is readable. Keep it available offline.
- [ ] If a weather provider is down but the app and database work, use the labeled synthetic cases and state that the live data is unavailable. If the app or database is unreachable, play the clip and explain it is a rehearsal. Never present a prerecorded result as live.
- [ ] After rehearsal, reset only the dedicated demo session. Keep the audit evidence and use a clean session for the pitch.

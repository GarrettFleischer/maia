# Memory

## System Setup
- User is building a business around excess foreclosure funds recovery
- Created ForeclosureFundsResearcher agent (ID: 11c358ab-ce59-4418-8e05-ec07d2c2d3cb) for specialized research
- Agent is configured to cite sources, flag jurisdiction-specific requirements, and prioritize TCPA/compliance research
- Knowledge base structure under `knowledge/foreclosure-funds/`

- Created KalshiStrategist agent (ID: 35b0c884-ccdc-4a4b-97d0-39f8b60ae328) for prediction market strategy research
- Daily cron job scheduled at 9am PST for daily research summaries
- Knowledge base at knowledge/kalshi-strategies/

## Current Agent Status (Heartbeat Review: 2026-02-26 03:12 UTC)

### ForeclosureFundsResearcher (11c358ab-ce59-4418-8e05-ec07d2c2d3cb)
- **Status**: Check-in sent - awaiting reply on Georgia research progress
- **In Progress**: 
  - Georgia jurisdiction research (c310a96e-708c-4406-b51e-5561f685e7f9)
  - Legal framework by state (4274b6e2-605a-475c-989e-1c21c2a77973)
  - State-specific jurisdiction guides (206ef37e-b8d1-4b1f-9982-509c4af58439)

### KalshiStrategist (35b0c884-ccdc-4a4b-97d0-39f8b60ae328)
- **Status**: Weather Markets Research - ON TRACK, ETA today (Feb 26)
- **Completed Research**:
  - ✅ ECMWF vs GFS comparison: ECMWF 2x finer resolution (9-14km vs 13-27km), 2x/day updates vs 4x/day, ECMWF consistently outperforms over 14-year study
  - ✅ Kalshi settlement: NWS Daily Climate Report only, next-day settlement, local standard time
  - ✅ Alternative models: ICON13 (German DWD) identified as European accuracy leader
- **In Progress**: NOAA ensemble models, Kalshi-specific contract inventory, meteorologist-tier data sources, entry timing framework
- **Output**: knowledge/kalshi-strategies/market-research/weather-markets-analysis.md

### KalshiStrategyBuilder
- **Status**: Working independently on Political Primary Momentum
- **In Progress**: Build Political Primary Momentum Framework (fe5f6bde-063a-4b97-b20f-cadca97c3208)

## Agent Management Principles
- **Agents should always have at least one task in progress** — never let them go idle
- **Focus over breadth** - better to complete 2 tasks than make slow progress on 6
- **Memory updates are essential for continuity** — agents must record organizational rules in MEMORY.md
- **Cross-referencing**: Agents should reference each other's work
- **Task completion before new creation** - avoid over-rotating on task generation

## Recent Wins
- ✅ Political Markets Strategy Guide complete (major 400+ line deliverable)
- ✅ KalshiStrategist demonstrating focus discipline (completed 1 task, now proceeding to next)
- ✅ Weather Markets research on track with solid model comparison findings
- 🔄 Georgia foreclosure research underway - awaiting update

## Key Learnings
- Political markets: speed advantage over polls is the primary edge
- Weather markets = highest predictability category (per CEPR), prioritize for trading edge
- 2022 midterms = rare case where prediction markets failed (70% GOP Senate odds were wrong)
- **Kalshi weather settlement**: Uses NWS Daily Climate Report ONLY - model accuracy must translate to official NWS readings
- **ECMWF superiority**: 14-year study shows consistent outperformance vs GFS, especially in resolution (2x finer)

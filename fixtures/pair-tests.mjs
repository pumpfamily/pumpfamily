/** The pair tokens the local suite launches against, one per token program. Both trade on PumpSwap. */
export const PAIR_TESTS = [
  { saleId: 1, symbol: 'CATE', mint: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump', creatorFeeBps: 300, program: 'Token-2022' },
  // ⚠ Read the owner ON CHAIN before labelling one: ANSEM sat here as the "classic" case and is
  // Token-2022 too, so both runs exercised the same program.
  { saleId: 2, symbol: 'TROLL', mint: '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2', creatorFeeBps: 0, program: 'classic SPL' },
]
/** One direct PumpSwap hop, so the route's accounts are one pool's and can be cloned ahead. */
export const PAIR_ROUTE_QUERY = `&onlyDirectRoutes=true&dexes=${encodeURIComponent('Pump.fun Amm')}`

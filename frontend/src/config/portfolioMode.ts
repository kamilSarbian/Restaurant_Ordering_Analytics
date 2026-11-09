/** Return whether the frontend is presenting the bounded portfolio experience. */
export function isPortfolioModeEnabled(): boolean {
  return import.meta.env.VITE_PORTFOLIO_MODE === 'true';
}

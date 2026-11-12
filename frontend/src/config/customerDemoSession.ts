/** Return whether the build exposes the shared customer-demo entry point. */
export function isCustomerDemoSessionEntryEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_CUSTOMER_DEMO_SESSION === 'true';
}

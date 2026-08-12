import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiRequestError } from '../../api/client';
import { createOrder, fetchMenu, quoteOrder } from '../../api/customerApi';
import type {
  MenuItem,
  OrderCreateRequest,
  OrderType,
  QuoteResponse,
} from '../../api/types';
import AsyncNotice from '../../components/AsyncNotice';
import { saveOrderAccess } from '../checkout/orderAccessStorage';
import { useCart } from './CartContext';
import styles from './CartPage.module.css';
import QuantityControl from './QuantityControl';

const QUOTE_DEBOUNCE_MS = 400;

type MenuLookupState =
  | { status: 'error' }
  | { items: Map<string, MenuItem>; status: 'loaded' }
  | { status: 'loading' };

interface QuoteSnapshot {
  quote: QuoteResponse;
  signature: string;
}

type QuoteState =
  | { status: 'idle' }
  | { signature: string; snapshot: QuoteSnapshot | null; status: 'pending' }
  | { signature: string; snapshot: QuoteSnapshot; status: 'success' }
  | {
      message: string;
      signature: string;
      snapshot: QuoteSnapshot | null;
      status: 'error';
    };

type OrderSubmissionState =
  | { status: 'idle' }
  | { status: 'refreshing-quote' }
  | { status: 'creating' }
  | { focusTable?: boolean; message: string; status: 'error' }
  | { message: string; status: 'ambiguous' }
  | {
      orderAccessToken: string;
      publicOrderNumber: string;
      status: 'navigation-error';
    };

function formatAmount(amount: number, currency: string): string {
  const fallback = `${amount} minor units ${currency}`;
  try {
    const formatter = new Intl.NumberFormat('en-NO', { currency, style: 'currency' });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
    const divisor = 10 ** fractionDigits;
    return Number.isSafeInteger(divisor) && divisor > 0
      ? formatter.format(amount / divisor)
      : fallback;
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return fallback;
    }
    return fallback;
  }
}

function getQuoteErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.kind === 'timeout') {
      return 'The quote request took too long. Please retry.';
    }
    if (error.kind === 'network') {
      return 'We could not connect to the quote service. Check your connection and retry.';
    }
    if (error.kind === 'invalid-response') {
      return 'The quote service returned an invalid response. Please retry.';
    }
    if (error.kind === 'http' && error.status === 404) {
      return 'An item in your cart is no longer available. Review the menu or remove stale items.';
    }
    if (error.kind === 'http' && error.status === 409) {
      return 'One or more items cannot currently be quoted. Review availability and your cart.';
    }
    if (error.kind === 'http' && error.status === 422) {
      return 'The cart could not be quoted. Review item quantities and try again.';
    }
  }
  return 'We could not update your quote. Please retry.';
}

function parsePositiveTableNumber(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isAmbiguousOrderError(error: unknown): boolean {
  return (
    !(error instanceof ApiRequestError) ||
    ['aborted', 'invalid-response', 'network', 'timeout'].includes(error.kind)
  );
}

function getDefinitiveOrderErrorMessage(error: ApiRequestError): string {
  if (error.kind === 'http' && error.status === 422) {
    return 'The order could not be created. Check the table number and cart details.';
  }
  if (error.kind === 'http' && error.status === 429) {
    return 'Too many order attempts were made. Wait before making another deliberate attempt.';
  }
  if (error.kind === 'http' && error.status === 404) {
    return 'An item is no longer on the menu. Review the menu and refresh your quote.';
  }
  if (error.kind === 'http' && error.status === 409) {
    return 'An item is unavailable or the order conflicts with current restaurant data. Review the menu and quote.';
  }
  return 'The server rejected the order. Review the cart before trying again.';
}

export default function CartPage() {
  const navigate = useNavigate();
  const { clearCart, decrementItem, incrementItem, items, removeItem, totalQuantity } =
    useCart();
  const [menuLookup, setMenuLookup] = useState<MenuLookupState>({
    status: 'loading',
  });
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: 'idle' });
  const [retryVersion, setRetryVersion] = useState(0);
  const [orderType, setOrderType] = useState<OrderType>('takeaway');
  const [tableNumberInput, setTableNumberInput] = useState('');
  const [orderState, setOrderState] = useState<OrderSubmissionState>({
    status: 'idle',
  });
  const tableInputRef = useRef<HTMLInputElement>(null);
  const submissionInFlight = useRef(false);
  const hasItems = items.length > 0;
  const quoteItems = useMemo(
    () =>
      items.map((item) => ({
        menu_item_id: item.menuItemId,
        quantity: item.quantity,
      })),
    [items],
  );
  const cartSignature = useMemo(
    () => items.map((item) => `${item.menuItemId}:${item.quantity}`).join('|'),
    [items],
  );
  const latestSignature = useRef(cartSignature);
  const tableNumber =
    orderType === 'dine_in' ? parsePositiveTableNumber(tableNumberInput) : null;
  const tableNumberIsValid = orderType === 'takeaway' || tableNumber !== null;
  const orderRequestInFlight =
    orderState.status === 'refreshing-quote' || orderState.status === 'creating';
  const backendTableError =
    orderState.status === 'error' && orderState.focusTable === true;

  useEffect(() => {
    latestSignature.current = cartSignature;
  }, [cartSignature]);

  useEffect(() => {
    if (!hasItems) {
      return undefined;
    }
    const controller = new AbortController();
    void fetchMenu(controller.signal)
      .then((menu) => {
        const lookup = new Map<string, MenuItem>();
        for (const category of menu.categories) {
          for (const item of category.items) {
            lookup.set(item.id, item);
          }
        }
        setMenuLookup({ items: lookup, status: 'loaded' });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMenuLookup({ status: 'error' });
        }
      });
    return () => controller.abort();
  }, [hasItems]);

  useEffect(() => {
    if (!hasItems) {
      return undefined;
    }
    const controller = new AbortController();
    const signature = cartSignature;
    const timeoutId = window.setTimeout(() => {
      setQuoteState((current) => ({
        signature,
        snapshot: 'snapshot' in current ? current.snapshot : null,
        status: 'pending',
      }));
      void quoteOrder(quoteItems, controller.signal)
        .then((quote) => {
          if (!controller.signal.aborted && latestSignature.current === signature) {
            const snapshot = { quote, signature };
            setQuoteState({ signature, snapshot, status: 'success' });
          }
        })
        .catch((error: unknown) => {
          if (
            !controller.signal.aborted &&
            latestSignature.current === signature &&
            !(error instanceof ApiRequestError && error.kind === 'aborted')
          ) {
            setQuoteState((current) => ({
              message: getQuoteErrorMessage(error),
              signature,
              snapshot: 'snapshot' in current ? current.snapshot : null,
              status: 'error',
            }));
          }
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [cartSignature, hasItems, quoteItems, retryVersion]);

  useEffect(() => {
    if (orderState.status === 'error' && orderState.focusTable === true) {
      tableInputRef.current?.focus();
    }
  }, [orderState]);

  if (!hasItems) {
    return (
      <div className={styles.page}>
        <h1>Your cart</h1>
        <AsyncNotice title="Your cart is empty.">
          <Link to="/">Browse the menu</Link>
        </AsyncNotice>
      </div>
    );
  }

  const currentSnapshot =
    'snapshot' in quoteState && quoteState.snapshot?.signature === cartSignature
      ? quoteState.snapshot
      : null;
  const quoteIsCurrent =
    quoteState.status === 'success' && quoteState.signature === cartSignature;
  const currentQuote = quoteIsCurrent ? (currentSnapshot?.quote ?? null) : null;
  const currentQuoteCurrency = currentQuote?.currency;
  const quotedLines = new Map(
    currentQuote?.items.map((line) => [line.menu_item_id, line]) ?? [],
  );
  const quoteErrorIsCurrent =
    quoteState.status === 'error' && quoteState.signature === cartSignature;
  const previousSnapshot =
    'snapshot' in quoteState && quoteState.snapshot?.signature !== cartSignature
      ? quoteState.snapshot
      : null;
  const canPlaceOrder =
    quoteIsCurrent &&
    tableNumberIsValid &&
    !orderRequestInFlight &&
    orderState.status !== 'ambiguous' &&
    orderState.status !== 'navigation-error';

  const navigateToCheckout = (publicOrderNumber: string, token: string) => {
    navigate(`/orders/${publicOrderNumber}/checkout`, {
      state: {
        orderAccessToken: token,
        publicOrderNumber,
      },
    });
  };

  const submitOrder = async (deliberateRetry = false) => {
    if (
      submissionInFlight.current ||
      !quoteIsCurrent ||
      !tableNumberIsValid ||
      (orderState.status === 'ambiguous' && !deliberateRetry) ||
      orderState.status === 'navigation-error'
    ) {
      if (!tableNumberIsValid) {
        tableInputRef.current?.focus();
      }
      return;
    }

    submissionInFlight.current = true;
    const submittedSignature = cartSignature;
    const submittedItems = quoteItems.map((item) => ({ ...item }));
    setOrderState({ status: 'refreshing-quote' });
    try {
      let freshQuote: QuoteResponse;
      try {
        freshQuote = await quoteOrder(submittedItems);
      } catch (error: unknown) {
        if (latestSignature.current === submittedSignature) {
          setQuoteState((current) => ({
            message: getQuoteErrorMessage(error),
            signature: submittedSignature,
            snapshot: 'snapshot' in current ? current.snapshot : null,
            status: 'error',
          }));
        }
        setOrderState({
          message:
            'A fresh server quote could not be confirmed. No order request was sent.',
          status: 'error',
        });
        return;
      }

      if (latestSignature.current !== submittedSignature) {
        setOrderState({
          message:
            'Your cart changed while prices were being confirmed. Review the updated quote before placing the order.',
          status: 'error',
        });
        return;
      }

      const freshSnapshot = { quote: freshQuote, signature: submittedSignature };
      setQuoteState({
        signature: submittedSignature,
        snapshot: freshSnapshot,
        status: 'success',
      });
      setOrderState({ status: 'creating' });
      const request: OrderCreateRequest =
        orderType === 'dine_in'
          ? {
              items: submittedItems,
              order_type: 'dine_in',
              table_number: tableNumber!,
            }
          : { items: submittedItems, order_type: 'takeaway' };

      try {
        const createdOrder = await createOrder(request);
        saveOrderAccess(
          createdOrder.public_order_number,
          createdOrder.order_access_token,
        );
        try {
          navigateToCheckout(
            createdOrder.public_order_number,
            createdOrder.order_access_token,
          );
        } catch {
          setOrderState({
            orderAccessToken: createdOrder.order_access_token,
            publicOrderNumber: createdOrder.public_order_number,
            status: 'navigation-error',
          });
        }
      } catch (error: unknown) {
        if (isAmbiguousOrderError(error)) {
          setOrderState({
            message:
              'We could not confirm the result. The order may have been created. Retrying can create a duplicate order, so make another attempt only if you accept that risk.',
            status: 'ambiguous',
          });
          return;
        }
        const requestError = error as ApiRequestError;
        setOrderState({
          focusTable: requestError.kind === 'http' && requestError.status === 422,
          message: getDefinitiveOrderErrorMessage(requestError),
          status: 'error',
        });
      }
    } finally {
      submissionInFlight.current = false;
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitOrder();
  };

  const retryNavigation = () => {
    if (orderState.status !== 'navigation-error') {
      return;
    }
    try {
      navigateToCheckout(orderState.publicOrderNumber, orderState.orderAccessToken);
    } catch {
      return;
    }
  };

  const disabledReason = !tableNumberIsValid
    ? 'Enter a positive whole table number to continue.'
    : quoteErrorIsCurrent
      ? 'Resolve the quote error before placing the order.'
      : !quoteIsCurrent
        ? 'Wait for a current server quote before placing the order.'
        : orderRequestInFlight
          ? 'Order creation is already in progress.'
          : orderState.status === 'ambiguous'
            ? 'Use the deliberate retry control only after reviewing the duplicate-order warning.'
            : orderState.status === 'navigation-error'
              ? 'The order already exists. Continue to its checkout page instead of creating it again.'
              : 'A fresh server quote will be checked again before the order is created.';

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Review your choices</p>
          <h1>Your cart</h1>
          <p>
            {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'} across{' '}
            {items.length} {items.length === 1 ? 'dish' : 'dishes'}.
          </p>
        </div>
        <Link className={styles.menuLink} to="/">
          Continue browsing
        </Link>
      </header>

      <div className={styles.layout}>
        <section aria-labelledby="cart-items-heading">
          <div className={styles.sectionHeading}>
            <h2 id="cart-items-heading">Cart items</h2>
            <button
              className={styles.clearButton}
              type="button"
              disabled={orderRequestInFlight}
              onClick={clearCart}
            >
              Clear cart
            </button>
          </div>
          {menuLookup.status === 'error' && (
            <p className={styles.lookupWarning} role="status">
              Current item details are unavailable. Your cart and server quote are
              preserved.
            </p>
          )}
          <ul className={styles.lineList}>
            {items.map((cartItem) => {
              const menuItem =
                menuLookup.status === 'loaded'
                  ? menuLookup.items.get(cartItem.menuItemId)
                  : undefined;
              const itemName =
                menuLookup.status === 'loading'
                  ? 'Loading item details…'
                  : menuLookup.status === 'error'
                    ? 'Item details unavailable'
                    : (menuItem?.name ?? 'Item no longer available');
              const quotedLine = quotedLines.get(cartItem.menuItemId);

              return (
                <li className={styles.cartLine} key={cartItem.menuItemId}>
                  <div>
                    <h3>{itemName}</h3>
                    {menuItem !== undefined && (
                      <p
                        className={styles.availability}
                        data-available={menuItem.is_available}
                      >
                        {menuItem.is_available
                          ? 'Currently available'
                          : 'Currently unavailable — remove or review the menu'}
                      </p>
                    )}
                    {menuLookup.status === 'loaded' && menuItem === undefined && (
                      <p className={styles.availability} data-available="false">
                        Remove this stale item or review the menu.
                      </p>
                    )}
                  </div>
                  <QuantityControl
                    itemName={itemName}
                    quantity={cartItem.quantity}
                    onDecrement={() => {
                      if (!orderRequestInFlight) decrementItem(cartItem.menuItemId);
                    }}
                    onIncrement={() => {
                      if (!orderRequestInFlight) incrementItem(cartItem.menuItemId);
                    }}
                  />
                  <button
                    className={styles.removeButton}
                    type="button"
                    disabled={orderRequestInFlight}
                    aria-label={`Remove ${itemName} from cart`}
                    onClick={() => removeItem(cartItem.menuItemId)}
                  >
                    Remove
                  </button>
                  {quotedLine !== undefined && currentQuoteCurrency !== undefined && (
                    <dl className={styles.lineAmounts}>
                      <div>
                        <dt>Quoted unit price</dt>
                        <dd>
                          {formatAmount(
                            quotedLine.unit_price_amount,
                            currentQuoteCurrency,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Quoted line total</dt>
                        <dd>
                          {formatAmount(
                            quotedLine.line_total_amount,
                            currentQuoteCurrency,
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <aside className={styles.summary} aria-labelledby="quote-heading">
          <h2 id="quote-heading">Server quote</h2>
          <p className={styles.authorityNote}>
            Totals are calculated by the restaurant server from current prices and
            availability.
          </p>

          {!quoteIsCurrent && !quoteErrorIsCurrent && (
            <div className={styles.updating} role="status" aria-live="polite">
              <strong>Updating total…</strong>
              {previousSnapshot !== null && (
                <p>
                  Previous quote — updating:{' '}
                  {formatAmount(
                    previousSnapshot.quote.total_amount,
                    previousSnapshot.quote.currency,
                  )}
                </p>
              )}
            </div>
          )}

          {quoteErrorIsCurrent && quoteState.status === 'error' && (
            <AsyncNotice tone="error" title="Unable to update quote">
              <p>{quoteState.message}</p>
              <div className={styles.errorActions}>
                <button
                  className={styles.retryButton}
                  type="button"
                  onClick={() => setRetryVersion((version) => version + 1)}
                >
                  Retry quote
                </button>
                <Link to="/">Review menu</Link>
              </div>
            </AsyncNotice>
          )}

          {currentQuote !== null && (
            <div className={styles.quoteResult} aria-live="polite">
              <ul aria-label="Quoted items">
                {currentQuote.items.map((line) => (
                  <li key={line.menu_item_id}>
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <strong>
                      {formatAmount(line.line_total_amount, currentQuote.currency)}
                    </strong>
                  </li>
                ))}
              </ul>
              <dl className={styles.totals}>
                <div>
                  <dt>Subtotal</dt>
                  <dd>
                    {formatAmount(currentQuote.subtotal_amount, currentQuote.currency)}
                  </dd>
                </div>
                <div className={styles.totalRow}>
                  <dt>Total</dt>
                  <dd>
                    {formatAmount(currentQuote.total_amount, currentQuote.currency)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <form className={styles.orderForm} onSubmit={handleSubmit}>
            <fieldset disabled={orderRequestInFlight}>
              <legend>Order type</legend>
              <label>
                <input
                  type="radio"
                  name="order-type"
                  value="takeaway"
                  checked={orderType === 'takeaway'}
                  onChange={() => {
                    setOrderType('takeaway');
                    setTableNumberInput('');
                    if (backendTableError) setOrderState({ status: 'idle' });
                  }}
                />
                Takeaway
              </label>
              <label>
                <input
                  type="radio"
                  name="order-type"
                  value="dine_in"
                  checked={orderType === 'dine_in'}
                  onChange={() => {
                    setOrderType('dine_in');
                    if (backendTableError) setOrderState({ status: 'idle' });
                  }}
                />
                Dine in
              </label>
            </fieldset>

            {orderType === 'dine_in' && (
              <div className={styles.tableField}>
                <label htmlFor="table-number">Table number</label>
                <input
                  ref={tableInputRef}
                  id="table-number"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={tableNumberInput}
                  aria-describedby={
                    backendTableError
                      ? 'table-number-help table-number-error'
                      : 'table-number-help'
                  }
                  aria-invalid={!tableNumberIsValid || backendTableError}
                  disabled={orderRequestInFlight}
                  onChange={(event) => {
                    setTableNumberInput(event.target.value);
                    if (backendTableError) setOrderState({ status: 'idle' });
                  }}
                />
                <p id="table-number-help">
                  Enter the positive whole number shown on your restaurant table.
                </p>
                {backendTableError && (
                  <p className={styles.tableError} id="table-number-error">
                    The restaurant could not validate this table. Check the number or
                    ask staff for help.
                  </p>
                )}
              </div>
            )}

            {orderState.status === 'refreshing-quote' && (
              <p className={styles.submissionStatus} role="status" aria-live="polite">
                Confirming current prices…
              </p>
            )}
            {orderState.status === 'creating' && (
              <p className={styles.submissionStatus} role="status" aria-live="polite">
                Creating your order…
              </p>
            )}
            {orderState.status === 'error' && (
              <AsyncNotice tone="error" title="Unable to create order">
                {orderState.message}
              </AsyncNotice>
            )}
            {orderState.status === 'ambiguous' && (
              <AsyncNotice tone="error" title="Order result uncertain">
                <p>{orderState.message}</p>
                <button
                  className={styles.deliberateRetryButton}
                  type="button"
                  onClick={() => void submitOrder(true)}
                >
                  Create another order attempt
                </button>
              </AsyncNotice>
            )}
            {orderState.status === 'navigation-error' && (
              <AsyncNotice tone="error" title="Order created, navigation interrupted">
                <p>
                  Order {orderState.publicOrderNumber} was created. Do not create it
                  again.
                </p>
                <button
                  className={styles.deliberateRetryButton}
                  type="button"
                  onClick={retryNavigation}
                >
                  Continue to payment setup
                </button>
              </AsyncNotice>
            )}

            <p className={styles.ctaHelp} id="place-order-help">
              {disabledReason}
            </p>
            <button
              className={styles.placeOrderButton}
              type="submit"
              aria-describedby="place-order-help"
              disabled={!canPlaceOrder}
            >
              Place order and continue to payment
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

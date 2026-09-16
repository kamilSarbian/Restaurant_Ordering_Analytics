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
import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import { useAuth } from '../auth/AuthContext';
import { saveOrderAccess } from '../checkout/orderAccessStorage';
import { resolveMenuImage } from '../menu/menuImageCatalog';
import { useCart } from './CartContext';
import styles from './CartPage.module.css';
import QuantityControl from './QuantityControl';

const CART_ITEM_IMAGE_SIZES =
  '(min-width: 64rem) 7rem, (min-width: 40rem) 6rem, 5.5rem';
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
  | { status: 'session-expired' }
  | { focusTable?: boolean; message: string; status: 'error' }
  | { message: string; status: 'ambiguous' }
  | {
      publicOrderNumber: string;
      status: 'navigation-error';
    };

interface SubmissionFocusIntent {
  readonly origin: HTMLElement | null;
}

function getFocusOrigin(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function shouldRestoreAsyncFocus(origin: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === origin ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  );
}

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

interface CartItemThumbnailProps {
  item: MenuItem | undefined;
}

function CartItemThumbnail({ item }: CartItemThumbnailProps) {
  const resolvedImage =
    item === undefined ? null : resolveMenuImage(item.id, item.image_url);
  const safeImageUrl =
    resolvedImage?.kind === 'responsive'
      ? resolvedImage.asset.pngSrc
      : (resolvedImage?.src ?? null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const showImage = safeImageUrl !== null && failedImageUrl !== safeImageUrl;

  return (
    <div
      aria-hidden={true}
      className={styles.thumbnail}
      data-image-state={showImage ? 'ready' : 'placeholder'}
    >
      {showImage ? (
        resolvedImage?.kind === 'responsive' ? (
          <picture>
            <source
              sizes={CART_ITEM_IMAGE_SIZES}
              srcSet={resolvedImage.asset.webpSrcSet}
              type={'image/webp'}
            />
            <img
              alt={''}
              decoding={'async'}
              height={resolvedImage.asset.height}
              loading={'lazy'}
              onError={() => setFailedImageUrl(safeImageUrl)}
              src={resolvedImage.asset.pngSrc}
              width={resolvedImage.asset.width}
            />
          </picture>
        ) : (
          <img
            alt={''}
            decoding={'async'}
            height={1086}
            loading={'lazy'}
            onError={() => setFailedImageUrl(safeImageUrl)}
            src={safeImageUrl}
            width={1448}
          />
        )
      ) : (
        <BrandMark className={styles.thumbnailMark} size={32} />
      )}
    </div>
  );
}

export default function CartPage() {
  const navigate = useNavigate();
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    phase: authPhase,
    retrySession,
  } = useAuth();
  const currentAuthRef = useRef({ getAuthenticatedSession, phase: authPhase });
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
  const [clearCartConfirmationOpen, setClearCartConfirmationOpen] = useState(false);
  const [cartMutationMessage, setCartMutationMessage] = useState('');
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const quoteRetryButtonRef = useRef<HTMLButtonElement>(null);
  const clearCartButtonRef = useRef<HTMLButtonElement>(null);
  const cancelClearCartButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingRemovalFocusRef = useRef<string | null | undefined>(undefined);
  const restoreQuoteRetryFocusRef = useRef(false);
  const restoreClearButtonFocusRef = useRef(false);
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
  const submissionFocusIntentRef = useRef<SubmissionFocusIntent | null>(null);
  const tableNumber =
    orderType === 'dine_in' ? parsePositiveTableNumber(tableNumberInput) : null;
  const tableNumberIsValid = orderType === 'takeaway' || tableNumber !== null;
  const orderRequestInFlight =
    orderState.status === 'refreshing-quote' || orderState.status === 'creating';
  const authIsResolved =
    authPhase === 'authenticated' || authPhase === 'unauthenticated';
  const backendTableError =
    orderState.status === 'error' && orderState.focusTable === true;

  useEffect(() => {
    currentAuthRef.current = { getAuthenticatedSession, phase: authPhase };
  }, [authPhase, getAuthenticatedSession]);

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
    if (orderState.status === 'refreshing-quote' || orderState.status === 'creating') {
      return;
    }
    const focusIntent = submissionFocusIntentRef.current;
    submissionFocusIntentRef.current = null;
    if (
      focusIntent !== null &&
      orderState.status === 'error' &&
      orderState.focusTable === true &&
      shouldRestoreAsyncFocus(focusIntent.origin)
    ) {
      tableInputRef.current?.focus();
    }
  }, [orderState]);

  useEffect(() => {
    const targetMenuItemId = pendingRemovalFocusRef.current;
    if (targetMenuItemId === undefined) {
      return;
    }
    pendingRemovalFocusRef.current = undefined;
    if (targetMenuItemId !== null) {
      const target = removeButtonRefs.current.get(targetMenuItemId);
      if (target !== undefined) {
        target.focus();
        return;
      }
    }
    pageHeadingRef.current?.focus();
  }, [items]);

  useEffect(() => {
    if (clearCartConfirmationOpen) {
      cancelClearCartButtonRef.current?.focus();
      return;
    }
    if (restoreClearButtonFocusRef.current) {
      restoreClearButtonFocusRef.current = false;
      clearCartButtonRef.current?.focus();
    }
  }, [clearCartConfirmationOpen]);

  useEffect(() => {
    if (!restoreQuoteRetryFocusRef.current) {
      return;
    }
    if (!hasItems) {
      restoreQuoteRetryFocusRef.current = false;
      return;
    }
    if (quoteState.status === 'idle' || quoteState.status === 'pending') {
      return;
    }

    const retryFailed =
      quoteState.status === 'error' && quoteState.signature === cartSignature;
    restoreQuoteRetryFocusRef.current = false;
    const activeElement = document.activeElement;
    if (retryFailed && (activeElement === document.body || activeElement === null)) {
      quoteRetryButtonRef.current?.focus();
    }
  }, [cartSignature, hasItems, quoteState]);

  const retryQuote = () => {
    restoreQuoteRetryFocusRef.current = true;
    setRetryVersion((version) => version + 1);
  };

  const removeCartItem = (menuItemId: string, itemName: string) => {
    const itemIndex = items.findIndex((item) => item.menuItemId === menuItemId);
    const nextItem = items[itemIndex + 1] ?? items[itemIndex - 1] ?? null;
    pendingRemovalFocusRef.current = nextItem?.menuItemId ?? null;
    setCartMutationMessage(`${itemName} removed from your cart.`);
    removeItem(menuItemId);
  };

  const requestClearCart = () => {
    setCartMutationMessage('');
    setClearCartConfirmationOpen(true);
  };

  const cancelClearCart = () => {
    restoreClearButtonFocusRef.current = true;
    setCartMutationMessage('Your cart was kept.');
    setClearCartConfirmationOpen(false);
  };

  const confirmClearCart = () => {
    pendingRemovalFocusRef.current = null;
    setCartMutationMessage('All items were removed from your cart.');
    setClearCartConfirmationOpen(false);
    clearCart();
  };

  if (!hasItems) {
    return (
      <div className={[styles.page, styles.emptyPage].join(' ')}>
        <BrandMark className={styles.emptyMark} size={48} />
        <p className={styles.eyebrow}>A fresh meal is a few choices away</p>
        <h1 ref={pageHeadingRef} tabIndex={-1}>
          Your cart
        </h1>
        <p className={styles.emptyLead}>
          Your table is ready. Choose a dish and return here when you are ready to
          order.
        </p>
        <AsyncNotice title="Your cart is empty.">
          <Link to="/menu">Browse the menu</Link>
        </AsyncNotice>
        {cartMutationMessage !== '' && (
          <p className={styles.mutationStatus} role={'status'}>
            {cartMutationMessage}
          </p>
        )}
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
  const retainedSnapshot = 'snapshot' in quoteState ? quoteState.snapshot : null;
  const summaryQuote = currentQuote ?? retainedSnapshot?.quote ?? null;
  const summaryQuoteIsPrevious = currentQuote === null && summaryQuote !== null;
  const canPlaceOrder =
    quoteIsCurrent &&
    tableNumberIsValid &&
    authIsResolved &&
    !orderRequestInFlight &&
    orderState.status !== 'ambiguous' &&
    orderState.status !== 'session-expired' &&
    orderState.status !== 'navigation-error';

  const navigateToCheckout = (publicOrderNumber: string) => {
    navigate(`/orders/${publicOrderNumber}/checkout`);
  };

  const submitOrder = async (deliberateRetry = false) => {
    if (
      submissionInFlight.current ||
      !quoteIsCurrent ||
      !tableNumberIsValid ||
      !authIsResolved ||
      (orderState.status === 'ambiguous' && !deliberateRetry) ||
      orderState.status === 'session-expired' ||
      orderState.status === 'navigation-error'
    ) {
      if (!tableNumberIsValid) {
        tableInputRef.current?.focus();
      }
      return;
    }

    submissionInFlight.current = true;
    submissionFocusIntentRef.current = { origin: getFocusOrigin() };
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

      const currentAuth = currentAuthRef.current;
      if (
        currentAuth.phase !== 'authenticated' &&
        currentAuth.phase !== 'unauthenticated'
      ) {
        setOrderState({ status: 'idle' });
        return;
      }
      const requestSession =
        currentAuth.phase === 'authenticated'
          ? currentAuth.getAuthenticatedSession()
          : null;
      if (currentAuth.phase === 'authenticated' && requestSession === null) {
        setOrderState({ status: 'session-expired' });
        return;
      }

      try {
        const createdOrder = await createOrder(request, {
          accessToken: requestSession?.accessToken,
        });
        saveOrderAccess(
          createdOrder.public_order_number,
          createdOrder.order_access_token,
        );
        try {
          navigateToCheckout(createdOrder.public_order_number);
        } catch {
          setOrderState({
            publicOrderNumber: createdOrder.public_order_number,
            status: 'navigation-error',
          });
        }
      } catch (error: unknown) {
        if (
          requestSession !== null &&
          error instanceof ApiRequestError &&
          error.kind === 'http' &&
          error.status === 401
        ) {
          invalidateSessionIfCurrent(requestSession);
          setOrderState({ status: 'session-expired' });
          return;
        }
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
      navigateToCheckout(orderState.publicOrderNumber);
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
        : authPhase === 'checking-session'
          ? 'Wait while your saved session is checked before placing the order.'
          : authPhase === 'temporarily-unavailable'
            ? 'Resolve the saved session before placing the order.'
            : orderRequestInFlight
              ? 'Order creation is already in progress.'
              : orderState.status === 'ambiguous'
                ? 'Use the deliberate retry control only after reviewing the duplicate-order warning.'
                : orderState.status === 'session-expired'
                  ? 'Sign in again before making another deliberate order attempt.'
                  : orderState.status === 'navigation-error'
                    ? 'The order already exists. Continue to its checkout page instead of creating it again.'
                    : 'A fresh server quote will be checked again before the order is created.';

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Review your choices</p>
          <h1 ref={pageHeadingRef} tabIndex={-1}>
            Your cart
          </h1>
          <p className={styles.headerSummary}>
            {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'} across{' '}
            {items.length} {items.length === 1 ? 'dish' : 'dishes'}.
          </p>
        </div>
        <Link className={styles.menuLink} to="/menu">
          Continue shopping
        </Link>
      </header>

      <div className={styles.layout}>
        <section aria-labelledby="cart-items-heading">
          <div className={styles.sectionHeading}>
            <h2 id="cart-items-heading">Cart items</h2>
            {!clearCartConfirmationOpen && (
              <Button
                className={styles.clearButton}
                ref={clearCartButtonRef}
                size={'sm'}
                variant={'danger'}
                type="button"
                disabled={orderRequestInFlight}
                onClick={requestClearCart}
              >
                Clear cart
              </Button>
            )}
          </div>
          {clearCartConfirmationOpen && (
            <div
              aria-label={'Clear cart confirmation'}
              className={styles.clearConfirmation}
              role={'group'}
            >
              <p>
                Remove all {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'} from
                your cart?
              </p>
              <div className={styles.clearConfirmationActions}>
                <Button
                  disabled={orderRequestInFlight}
                  onClick={confirmClearCart}
                  size={'md'}
                  type={'button'}
                  variant={'danger'}
                >
                  Confirm clear cart
                </Button>
                <Button
                  onClick={cancelClearCart}
                  ref={cancelClearCartButtonRef}
                  size={'md'}
                  type={'button'}
                  variant={'secondary'}
                >
                  Cancel clear cart
                </Button>
              </div>
            </div>
          )}
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
                  <CartItemThumbnail item={menuItem} />
                  <div className={styles.itemDetails}>
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
                    disabled={orderRequestInFlight}
                    itemName={itemName}
                    quantity={cartItem.quantity}
                    onDecrement={() => {
                      if (!orderRequestInFlight) decrementItem(cartItem.menuItemId);
                    }}
                    onIncrement={() => {
                      if (!orderRequestInFlight) incrementItem(cartItem.menuItemId);
                    }}
                  />
                  <Button
                    className={styles.removeButton}
                    ref={(button) => {
                      if (button === null) {
                        removeButtonRefs.current.delete(cartItem.menuItemId);
                        return;
                      }
                      removeButtonRefs.current.set(cartItem.menuItemId, button);
                    }}
                    size={'sm'}
                    variant={'danger'}
                    type="button"
                    disabled={orderRequestInFlight}
                    aria-label={`Remove ${itemName} from cart`}
                    onClick={() => removeCartItem(cartItem.menuItemId, itemName)}
                  >
                    Remove
                  </Button>
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
          {cartMutationMessage !== '' && (
            <p className={styles.mutationStatus} role={'status'}>
              {cartMutationMessage}
            </p>
          )}
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
                  ref={quoteRetryButtonRef}
                  type="button"
                  onClick={retryQuote}
                >
                  Retry quote
                </button>
                <Link to="/menu">Review menu</Link>
              </div>
            </AsyncNotice>
          )}

          {summaryQuoteIsPrevious && (
            <p className={styles.previousQuoteLabel}>
              {'Previous server quote \u2014 awaiting a current total'}
            </p>
          )}

          {summaryQuote !== null && (
            <div className={styles.quoteResult} aria-live="polite">
              <ul aria-label="Quoted items">
                {summaryQuote.items.map((line) => (
                  <li key={line.menu_item_id}>
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <strong>
                      {formatAmount(line.line_total_amount, summaryQuote.currency)}
                    </strong>
                  </li>
                ))}
              </ul>
              <dl className={styles.totals}>
                <div>
                  <dt>Subtotal</dt>
                  <dd>
                    {formatAmount(summaryQuote.subtotal_amount, summaryQuote.currency)}
                  </dd>
                </div>
                <div className={styles.totalRow}>
                  <dt>Total</dt>
                  <dd>
                    {formatAmount(summaryQuote.total_amount, summaryQuote.currency)}
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

            {authPhase === 'checking-session' && (
              <p className={styles.submissionStatus} role="status" aria-live="polite">
                Checking your session before order creation...
              </p>
            )}
            {authPhase === 'temporarily-unavailable' && (
              <AsyncNotice tone="error" title="Session validation unavailable">
                <p>
                  Your saved identity could not be verified. No guest order will be
                  created unless you explicitly clear the session.
                </p>
                <div className={styles.errorActions}>
                  <button
                    className={styles.retryButton}
                    type="button"
                    onClick={() => void retrySession()}
                  >
                    Retry session validation
                  </button>
                  <button className={styles.retryButton} type="button" onClick={logout}>
                    Clear session
                  </button>
                </div>
              </AsyncNotice>
            )}
            {orderState.status === 'session-expired' && (
              <AsyncNotice tone="error" title="Session expired">
                <p>
                  The authenticated order request was not retried as a guest. Sign in
                  again before placing another order.
                </p>
                <Link to="/login?next=%2Fcart">Sign in again</Link>
              </AsyncNotice>
            )}

            <p className={styles.ctaHelp} id="place-order-help">
              {disabledReason}
            </p>
            <Button
              className={styles.placeOrderButton}
              loading={orderRequestInFlight}
              loadingLabel={
                orderState.status === 'creating'
                  ? 'Creating your order\u2026'
                  : 'Confirming current prices\u2026'
              }
              size={'lg'}
              variant={'primary'}
              type="submit"
              aria-describedby="place-order-help"
              disabled={!canPlaceOrder}
            >
              Place order and continue to payment
            </Button>
          </form>
        </aside>
      </div>
    </div>
  );
}

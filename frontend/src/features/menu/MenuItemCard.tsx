import { useState } from 'react';

import type { MenuItem } from '../../api/types';
import Button from '../../components/ui/Button';
import { useCart } from '../cart/CartContext';
import { MENU_IMAGE_SIZES, resolveMenuImage } from './menuImageCatalog';
import styles from './MenuPage.module.css';

interface MenuItemCardProps {
  item: MenuItem;
  priority?: boolean;
}

function formatPrice(priceAmount: number, currency: string): string {
  const fallback = priceAmount + ' minor units ' + currency;
  try {
    const formatter = new Intl.NumberFormat('en-NO', {
      currency,
      style: 'currency',
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
    const divisor = 10 ** fractionDigits;
    if (!Number.isSafeInteger(divisor) || divisor <= 0) {
      return fallback;
    }
    return formatter.format(priceAmount / divisor);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return fallback;
    }
    return fallback;
  }
}

/** Render one menu item with safe responsive image fallback and cart controls. */
export default function MenuItemCard({ item, priority = false }: MenuItemCardProps) {
  const { addItem, getQuantity } = useCart();
  const resolvedImage = resolveMenuImage(item.id, item.image_url);
  const safeImageUrl =
    resolvedImage?.kind === 'responsive'
      ? resolvedImage.asset.pngSrc
      : (resolvedImage?.src ?? null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [cartMessage, setCartMessage] = useState('');
  const showImage = safeImageUrl !== null && failedImageUrl !== safeImageUrl;
  const headingId = 'menu-item-' + item.id;
  const cardClassName = item.is_available
    ? styles.card
    : styles.card + ' ' + styles.cardUnavailable;
  const quantityInCart = getQuantity(item.id);

  const addToCart = () => {
    const result = addItem(item.id);
    if (result === 'quantity-limit') {
      setCartMessage(item.name + ' is already at the maximum quantity of 99.');
      return;
    }
    if (result === 'item-limit') {
      setCartMessage('Your cart already contains the maximum of 50 different items.');
      return;
    }
    setCartMessage(`${item.name} added to cart. Quantity is ${quantityInCart + 1}.`);
  };

  return (
    <article
      className={cardClassName}
      aria-labelledby={headingId}
      data-availability={item.is_available ? 'available' : 'unavailable'}
    >
      <div className={styles.imageArea}>
        {showImage ? (
          resolvedImage?.kind === 'responsive' ? (
            <picture className={styles.picture}>
              <source
                type="image/webp"
                srcSet={resolvedImage.asset.webpSrcSet}
                sizes={MENU_IMAGE_SIZES}
              />
              <img
                className={styles.imageFrame}
                src={resolvedImage.asset.pngSrc}
                alt={item.name}
                width={resolvedImage.asset.width}
                height={resolvedImage.asset.height}
                loading={priority ? 'eager' : 'lazy'}
                fetchPriority={priority ? 'high' : undefined}
                decoding="async"
                onError={() => setFailedImageUrl(safeImageUrl)}
              />
            </picture>
          ) : (
            <img
              className={styles.imageFrame}
              src={safeImageUrl}
              alt={item.name}
              width={1448}
              height={1086}
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : undefined}
              decoding="async"
              onError={() => setFailedImageUrl(safeImageUrl)}
            />
          )
        ) : (
          <div
            className={styles.imagePlaceholder}
            role="img"
            aria-label={item.name + ' image unavailable'}
          >
            Image unavailable
          </div>
        )}
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <h3 className={styles.cardTitle} id={headingId}>
            {item.name}
          </h3>
          <span className={styles.price}>
            {formatPrice(item.price_amount, item.currency)}
          </span>
        </div>

        {item.description !== null && (
          <p className={styles.description}>{item.description}</p>
        )}

        <div className={styles.itemDetails}>
          <p className={styles.availability} data-available={item.is_available}>
            <span aria-hidden="true">{item.is_available ? '✓' : '—'}</span>
            {item.is_available ? 'Available' : 'Temporarily unavailable'}
          </p>
          <div className={styles.allergenBlock}>
            <p className={styles.allergenLabel}>Allergens</p>
            {item.allergens.length === 0 ? (
              <p className={styles.allergenEmpty}>No allergens listed</p>
            ) : (
              <ul
                className={styles.allergenList}
                aria-label={'Allergens for ' + item.name}
              >
                {item.allergens.map((allergen, index) => (
                  <li className={styles.allergen} key={allergen + '-' + index}>
                    {allergen}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className={styles.cardFooter}>
          <Button
            className={styles.addButton}
            type="button"
            disabled={!item.is_available}
            onClick={addToCart}
          >
            {item.is_available ? 'Add to cart' : 'Unavailable'}
          </Button>
          {quantityInCart > 0 && (
            <p className={styles.inCart}>{quantityInCart} in cart</p>
          )}
          <p className={styles.cartFeedback} role="status" aria-live="polite">
            {cartMessage}
          </p>
        </div>
      </div>
    </article>
  );
}

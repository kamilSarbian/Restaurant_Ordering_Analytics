import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';

import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { getSafeMenuImageUrl } from '../menu/menuImageCatalog';
import type {
  AdminCategory,
  AdminMenuItem,
  AdminMenuItemCreatePayload,
  AdminMenuItemUpdatePayload,
} from './adminMenuApi';
import styles from './AdminMenuPage.module.css';

const MAX_MENU_MONEY_MINOR_UNITS = 2_147_483_647;
const MAX_MENU_MONEY_MINOR_UNITS_BIGINT = BigInt(MAX_MENU_MONEY_MINOR_UNITS);
const NOK_MINOR_UNIT_FACTOR = 100n;
const MAX_NOK_MAJOR_INPUT_LENGTH = 11;
const NOK_MAJOR_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

interface MenuItemFormProps {
  busy: boolean;
  categories: AdminCategory[];
  item: AdminMenuItem | null;
  onCancel: () => void;
  onSubmit: (
    payload: AdminMenuItemCreatePayload | AdminMenuItemUpdatePayload,
  ) => Promise<void>;
  submitLocked: boolean;
}

type FieldName =
  'category' | 'cost' | 'displayOrder' | 'form' | 'imageUrl' | 'name' | 'price';
type ItemErrors = Partial<Record<FieldName, string>>;

/** Format a validated NOK minor-unit integer as an exact major-unit string. */
export function formatNokMinorUnits(amount: number): string {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > MAX_MENU_MONEY_MINOR_UNITS
  ) {
    throw new RangeError('NOK minor units must fit the menu integer contract.');
  }
  const digits = String(amount).padStart(3, '0');
  return digits.slice(0, -2) + '.' + digits.slice(-2);
}

/** Parse an exact NOK major-unit string into bounded integer minor units. */
export function parseNokMajorUnits(value: string): number | null {
  if (value.length > MAX_NOK_MAJOR_INPUT_LENGTH) {
    return null;
  }
  const match = NOK_MAJOR_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const wholeDigits = match[1];
  if (wholeDigits === undefined) {
    return null;
  }
  const whole = BigInt(wholeDigits);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  const minorUnits = whole * NOK_MINOR_UNIT_FACTOR + fraction;
  if (minorUnits > MAX_MENU_MONEY_MINOR_UNITS_BIGINT) {
    return null;
  }
  const amount = Number(minorUnits);
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseInteger(value: string, minimum: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function parseAllergens(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((allergen) => allergen.trim())
    .filter((allergen) => allergen.length > 0);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

export default function MenuItemForm({
  busy,
  categories,
  item,
  onCancel,
  onSubmit,
  submitLocked,
}: MenuItemFormProps) {
  const initialCategoryId = item?.categoryId ?? categories[0]?.id ?? '';
  const initialName = item?.name ?? '';
  const initialDescription = item?.description ?? '';
  const initialImageUrl = item?.imageUrl ?? '';
  const initialPrice =
    item === null || item.currency !== 'NOK'
      ? ''
      : formatNokMinorUnits(item.priceAmount);
  const initialCost =
    item === null || item.costAmount === null || item.currency !== 'NOK'
      ? ''
      : formatNokMinorUnits(item.costAmount);
  const initialAllergens = item?.allergens.join('\n') ?? '';
  const initialDisplayOrder = String(item?.displayOrder ?? 0);
  const initialIsActive = item?.isActive ?? true;
  const initialIsAvailable = item?.isAvailable ?? true;
  const unsupportedCurrency = item !== null && item.currency !== 'NOK';

  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [imageUrl, setImageUrl] = useState(initialImageUrl);
  const [price, setPrice] = useState(initialPrice);
  const [cost, setCost] = useState(initialCost);
  const [allergens, setAllergens] = useState(initialAllergens);
  const [displayOrder, setDisplayOrder] = useState(initialDisplayOrder);
  const [isActive, setIsActive] = useState(initialIsActive);
  const [isAvailable, setIsAvailable] = useState(initialIsAvailable);
  const [errors, setErrors] = useState<ItemErrors>({});
  const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const displayOrderRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const restoreCancelFocusRef = useRef(false);

  const isDirty =
    categoryId !== initialCategoryId ||
    name !== initialName ||
    description !== initialDescription ||
    imageUrl !== initialImageUrl ||
    price !== initialPrice ||
    cost !== initialCost ||
    allergens !== initialAllergens ||
    displayOrder !== initialDisplayOrder ||
    isActive !== initialIsActive ||
    isAvailable !== initialIsAvailable;
  const safePreviewUrl = getSafeMenuImageUrl(imageUrl === '' ? null : imageUrl);
  const previewFailed = safePreviewUrl !== null && failedPreviewUrl === safePreviewUrl;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showDiscardConfirmation) {
      keepEditingRef.current?.focus();
      return;
    }
    if (restoreCancelFocusRef.current) {
      restoreCancelFocusRef.current = false;
      cancelRef.current?.focus();
    }
  }, [showDiscardConfirmation]);

  const focusFirstError = (nextErrors: ItemErrors) => {
    const refs: Array<[FieldName, RefObject<HTMLElement | null>]> = [
      ['category', categoryRef],
      ['name', nameRef],
      ['price', priceRef],
      ['cost', costRef],
      ['displayOrder', displayOrderRef],
      ['imageUrl', imageUrlRef],
    ];
    refs.find(([field]) => nextErrors[field] !== undefined)?.[1].current?.focus();
  };

  const handleCancel = () => {
    if (!isDirty) {
      onCancel();
      return;
    }
    setShowDiscardConfirmation(true);
  };

  const keepEditing = () => {
    restoreCancelFocusRef.current = true;
    setShowDiscardConfirmation(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitLocked) return;
    if (unsupportedCurrency) {
      setErrors({
        form: 'This menu item cannot be edited because its currency is not NOK.',
      });
      return;
    }

    const normalizedName = name.trim();
    const normalizedDescription = description === '' ? null : description;
    const normalizedImageUrl = imageUrl === '' ? null : imageUrl;
    const parsedPrice = parseNokMajorUnits(price);
    const parsedCost = cost === '' ? null : parseNokMajorUnits(cost);
    const parsedAllergens = parseAllergens(allergens);
    const parsedDisplayOrder = parseInteger(displayOrder, 0);
    const nextErrors: ItemErrors = {};

    if (!categories.some((category) => category.id === categoryId)) {
      nextErrors.category = 'Select a loaded category.';
    }
    if (normalizedName.length === 0) nextErrors.name = 'Enter a menu-item name.';
    else if (normalizedName.length > 120) {
      nextErrors.name = 'Menu-item name must contain at most 120 characters.';
    }
    if (parsedPrice === null || parsedPrice < 1) {
      nextErrors.price =
        'Price must be 0.01–21474836.47 NOK with at most two decimal places.';
    }
    if (cost !== '' && parsedCost === null) {
      nextErrors.cost =
        'Cost must be blank or 0.00–21474836.47 NOK with at most two decimal places.';
    }
    if (parsedDisplayOrder === null) {
      nextErrors.displayOrder = 'Display order must be a non-negative safe integer.';
    }
    if (normalizedImageUrl !== null && normalizedImageUrl.length > 2_048) {
      nextErrors.imageUrl = 'Image URL must contain at most 2048 characters.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      focusFirstError(nextErrors);
      return;
    }

    const values: AdminMenuItemCreatePayload = {
      allergens: parsedAllergens,
      category_id: categoryId,
      cost_amount: parsedCost,
      currency: 'NOK',
      description: normalizedDescription,
      display_order: parsedDisplayOrder as number,
      image_url: normalizedImageUrl,
      is_active: isActive,
      is_available: isAvailable,
      name: normalizedName,
      price_amount: parsedPrice as number,
    };
    if (item === null) {
      setErrors({});
      await onSubmit(values);
      return;
    }

    const payload: AdminMenuItemUpdatePayload = {};
    if (values.category_id !== item.categoryId)
      payload.category_id = values.category_id;
    if (values.name !== item.name) payload.name = values.name;
    if (values.description !== item.description)
      payload.description = values.description;
    if (values.image_url !== item.imageUrl) payload.image_url = values.image_url;
    if (values.price_amount !== item.priceAmount)
      payload.price_amount = values.price_amount;
    if (values.cost_amount !== item.costAmount)
      payload.cost_amount = values.cost_amount;
    if (!arraysEqual(values.allergens, item.allergens))
      payload.allergens = values.allergens;
    if (values.display_order !== item.displayOrder) {
      payload.display_order = values.display_order;
    }
    if (values.is_active !== item.isActive) payload.is_active = values.is_active;
    if (values.is_available !== item.isAvailable) {
      payload.is_available = values.is_available;
    }
    if (Object.keys(payload).length === 0) {
      setErrors({ form: 'Change at least one menu-item field before saving.' });
      return;
    }
    setErrors({});
    await onSubmit(payload);
  };

  return (
    <form
      aria-busy={busy}
      className={styles.formPanel}
      noValidate
      onSubmit={handleSubmit}
    >
      <div>
        <p className="eyebrow">Menu-item editor</p>
        <h3>{item === null ? 'Add menu item' : 'Edit menu item'}</h3>
        {isDirty ? (
          <p className={styles.dirtyIndicator} role="status">
            Unsaved changes
          </p>
        ) : null}
      </div>
      {errors.form !== undefined ? (
        <p className={styles.fieldError} role="alert">
          {errors.form}
        </p>
      ) : null}
      {submitLocked ? (
        <p className={styles.formWarning} role="alert">
          Refresh menu items before deliberately submitting this form again.
        </p>
      ) : null}
      <div className={styles.formGrid}>
        <label>
          Category
          <select
            ref={categoryRef}
            aria-describedby={errors.category ? 'item-category-error' : undefined}
            aria-invalid={errors.category !== undefined}
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
          {errors.category !== undefined ? (
            <span className={styles.fieldError} id="item-category-error">
              {errors.category}
            </span>
          ) : null}
        </label>
        <label>
          Name
          <input
            ref={nameRef}
            maxLength={121}
            aria-describedby={errors.name ? 'item-name-error' : undefined}
            aria-invalid={errors.name !== undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name !== undefined ? (
            <span className={styles.fieldError} id="item-name-error">
              {errors.name}
            </span>
          ) : null}
        </label>
        <label className={styles.fullWidthField}>
          Description
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className={styles.fullWidthField}>
          Image URL
          <input
            ref={imageUrlRef}
            aria-describedby={errors.imageUrl ? 'item-image-error' : undefined}
            aria-invalid={errors.imageUrl !== undefined}
            value={imageUrl}
            onChange={(event) => {
              setImageUrl(event.target.value);
              setFailedPreviewUrl(null);
            }}
          />
          {errors.imageUrl !== undefined ? (
            <span className={styles.fieldError} id="item-image-error">
              {errors.imageUrl}
            </span>
          ) : null}
        </label>
        <div className={[styles.imagePreview, styles.fullWidthField].join(' ')}>
          <p className={styles.imagePreviewLabel}>Image preview</p>
          <div className={styles.imagePreviewFrame}>
            {safePreviewUrl !== null && !previewFailed ? (
              <img
                alt={'Preview for ' + (name.trim() || 'menu item')}
                className={styles.imagePreviewImage}
                decoding="async"
                loading="lazy"
                referrerPolicy="no-referrer"
                src={safePreviewUrl}
                onError={() => setFailedPreviewUrl(safePreviewUrl)}
              />
            ) : (
              <p className={styles.imagePreviewPlaceholder}>
                {previewFailed
                  ? 'Image preview could not be loaded.'
                  : imageUrl === ''
                    ? 'Add an HTTP(S) or approved local menu image URL to preview it.'
                    : 'Preview unavailable for an unsafe or invalid image URL.'}
              </p>
            )}
          </div>
        </div>
        <label>
          Price (NOK)
          <input
            ref={priceRef}
            aria-label="Price (NOK)"
            inputMode="decimal"
            placeholder="129.00"
            aria-describedby={
              errors.price ? 'item-price-hint item-price-error' : 'item-price-hint'
            }
            aria-invalid={errors.price !== undefined}
            maxLength={MAX_NOK_MAJOR_INPUT_LENGTH}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <span className={styles.fieldHint} id="item-price-hint">
            Major units; up to two decimal places.
          </span>
          {errors.price !== undefined ? (
            <span className={styles.fieldError} id="item-price-error">
              {errors.price}
            </span>
          ) : null}
        </label>
        <label>
          Cost (NOK)
          <input
            ref={costRef}
            aria-label="Cost (NOK)"
            inputMode="decimal"
            placeholder="Optional"
            aria-describedby={
              errors.cost ? 'item-cost-hint item-cost-error' : 'item-cost-hint'
            }
            aria-invalid={errors.cost !== undefined}
            maxLength={MAX_NOK_MAJOR_INPUT_LENGTH}
            value={cost}
            onChange={(event) => setCost(event.target.value)}
          />
          <span className={styles.fieldHint} id="item-cost-hint">
            Optional; blank means unknown.
          </span>
          {errors.cost !== undefined ? (
            <span className={styles.fieldError} id="item-cost-error">
              {errors.cost}
            </span>
          ) : null}
        </label>
        <label>
          Display order
          <input
            ref={displayOrderRef}
            inputMode="numeric"
            aria-describedby={errors.displayOrder ? 'item-order-error' : undefined}
            aria-invalid={errors.displayOrder !== undefined}
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
          />
          {errors.displayOrder !== undefined ? (
            <span className={styles.fieldError} id="item-order-error">
              {errors.displayOrder}
            </span>
          ) : null}
        </label>
        <label className={styles.fullWidthField}>
          Allergens — one per line
          <textarea
            rows={4}
            value={allergens}
            onChange={(event) => setAllergens(event.target.value)}
          />
        </label>
      </div>
      <fieldset className={styles.booleanGroup}>
        <legend>Catalog controls</legend>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          Active — visible in the menu lifecycle
        </label>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={isAvailable}
            onChange={(event) => setIsAvailable(event.target.checked)}
          />
          Available — currently orderable
        </label>
      </fieldset>
      {showDiscardConfirmation ? (
        <Notice
          className={styles.discardConfirmation}
          title="Discard menu-item changes?"
          variant="warning"
        >
          <p>Your unsaved changes will be lost.</p>
          <div className={styles.formActions}>
            <Button type="button" size="sm" variant="danger" onClick={onCancel}>
              Discard changes
            </Button>
            <Button
              ref={keepEditingRef}
              type="button"
              size="sm"
              variant="secondary"
              onClick={keepEditing}
            >
              Keep editing
            </Button>
          </div>
        </Notice>
      ) : null}
      {!showDiscardConfirmation ? (
        <div className={styles.formActions}>
          <Button
            loading={busy}
            loadingLabel="Saving…"
            type="submit"
            disabled={submitLocked || unsupportedCurrency}
          >
            {item === null ? 'Create menu item' : 'Save changes'}
          </Button>
          <Button
            ref={cancelRef}
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={handleCancel}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </form>
  );
}

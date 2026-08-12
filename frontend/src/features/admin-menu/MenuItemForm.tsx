import { type FormEvent, useEffect, useRef, useState } from 'react';

import type {
  AdminCategory,
  AdminMenuItem,
  AdminMenuItemCreatePayload,
  AdminMenuItemUpdatePayload,
} from './adminMenuApi';
import styles from './AdminMenuPage.module.css';

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
  | 'category'
  | 'cost'
  | 'currency'
  | 'displayOrder'
  | 'form'
  | 'imageUrl'
  | 'name'
  | 'price';
type ItemErrors = Partial<Record<FieldName, string>>;

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
  const [categoryId, setCategoryId] = useState(
    item?.categoryId ?? categories[0]?.id ?? '',
  );
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [imageUrl, setImageUrl] = useState(item?.imageUrl ?? '');
  const [price, setPrice] = useState(item === null ? '' : String(item.priceAmount));
  const [cost, setCost] = useState(
    item?.costAmount === null || item === null ? '' : String(item.costAmount),
  );
  const [currency, setCurrency] = useState(item?.currency ?? 'NOK');
  const [allergens, setAllergens] = useState(item?.allergens.join('\n') ?? '');
  const [displayOrder, setDisplayOrder] = useState(String(item?.displayOrder ?? 0));
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [isAvailable, setIsAvailable] = useState(item?.isAvailable ?? true);
  const [errors, setErrors] = useState<ItemErrors>({});
  const categoryRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const currencyRef = useRef<HTMLInputElement>(null);
  const displayOrderRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const focusFirstError = (nextErrors: ItemErrors) => {
    const refs: Array<[FieldName, React.RefObject<HTMLElement | null>]> = [
      ['category', categoryRef],
      ['name', nameRef],
      ['price', priceRef],
      ['cost', costRef],
      ['currency', currencyRef],
      ['displayOrder', displayOrderRef],
      ['imageUrl', imageUrlRef],
    ];
    refs.find(([field]) => nextErrors[field] !== undefined)?.[1].current?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitLocked) return;

    const normalizedName = name.trim();
    const normalizedDescription = description === '' ? null : description;
    const normalizedImageUrl = imageUrl === '' ? null : imageUrl;
    const parsedPrice = parseInteger(price, 1);
    const parsedCost = cost === '' ? null : parseInteger(cost, 0);
    const normalizedCurrency = currency.toUpperCase();
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
    if (parsedPrice === null)
      nextErrors.price = 'Price must be a positive safe integer.';
    if (cost !== '' && parsedCost === null) {
      nextErrors.cost = 'Cost must be blank or a non-negative safe integer.';
    }
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      nextErrors.currency =
        'Currency must contain exactly three uppercase ASCII letters.';
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
      currency: normalizedCurrency,
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
    if (values.currency !== item.currency) payload.currency = values.currency;
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
    <form className={styles.formPanel} noValidate onSubmit={handleSubmit}>
      <div>
        <p className="eyebrow">Menu-item editor</p>
        <h3>{item === null ? 'Add menu item' : 'Edit menu item'}</h3>
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
            onChange={(event) => setImageUrl(event.target.value)}
          />
          {errors.imageUrl !== undefined ? (
            <span className={styles.fieldError} id="item-image-error">
              {errors.imageUrl}
            </span>
          ) : null}
        </label>
        <label>
          Price (minor units)
          <input
            ref={priceRef}
            inputMode="numeric"
            aria-describedby={errors.price ? 'item-price-error' : undefined}
            aria-invalid={errors.price !== undefined}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          {errors.price !== undefined ? (
            <span className={styles.fieldError} id="item-price-error">
              {errors.price}
            </span>
          ) : null}
        </label>
        <label>
          Cost (minor units, optional)
          <input
            ref={costRef}
            inputMode="numeric"
            aria-describedby={errors.cost ? 'item-cost-error' : undefined}
            aria-invalid={errors.cost !== undefined}
            value={cost}
            onChange={(event) => setCost(event.target.value)}
          />
          {errors.cost !== undefined ? (
            <span className={styles.fieldError} id="item-cost-error">
              {errors.cost}
            </span>
          ) : null}
        </label>
        <label>
          Currency
          <input
            ref={currencyRef}
            maxLength={3}
            aria-describedby={errors.currency ? 'item-currency-error' : undefined}
            aria-invalid={errors.currency !== undefined}
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
          {errors.currency !== undefined ? (
            <span className={styles.fieldError} id="item-currency-error">
              {errors.currency}
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
          Active — catalog record enabled
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
      <div className={styles.formActions}>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={busy || submitLocked}
        >
          {busy ? 'Saving…' : item === null ? 'Create menu item' : 'Save changes'}
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

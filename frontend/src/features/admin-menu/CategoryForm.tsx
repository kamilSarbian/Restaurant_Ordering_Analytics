import { type FormEvent, useEffect, useRef, useState } from 'react';

import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import type {
  AdminCategory,
  AdminCategoryCreatePayload,
  AdminCategoryUpdatePayload,
} from './adminMenuApi';
import styles from './AdminMenuPage.module.css';

interface CategoryFormProps {
  busy: boolean;
  category: AdminCategory | null;
  onCancel: () => void;
  onSubmit: (
    payload: AdminCategoryCreatePayload | AdminCategoryUpdatePayload,
  ) => Promise<void>;
  submitLocked: boolean;
}

interface CategoryErrors {
  displayOrder?: string;
  form?: string;
  name?: string;
}

function parseNonnegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export default function CategoryForm({
  busy,
  category,
  onCancel,
  onSubmit,
  submitLocked,
}: CategoryFormProps) {
  const initialName = category?.name ?? '';
  const initialDescription = category?.description ?? '';
  const initialDisplayOrder = String(category?.displayOrder ?? 0);
  const initialIsActive = category?.isActive ?? true;
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [displayOrder, setDisplayOrder] = useState(initialDisplayOrder);
  const [isActive, setIsActive] = useState(initialIsActive);
  const [errors, setErrors] = useState<CategoryErrors>({});
  const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const displayOrderRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const restoreCancelFocusRef = useRef(false);
  const isDirty =
    name !== initialName ||
    description !== initialDescription ||
    displayOrder !== initialDisplayOrder ||
    isActive !== initialIsActive;

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
    if (busy || submitLocked) {
      return;
    }

    const normalizedName = name.trim();
    const normalizedDescription = description === '' ? null : description;
    const parsedDisplayOrder = parseNonnegativeInteger(displayOrder);
    const nextErrors: CategoryErrors = {};
    if (normalizedName.length === 0) {
      nextErrors.name = 'Enter a category name.';
    } else if (normalizedName.length > 120) {
      nextErrors.name = 'Category name must contain at most 120 characters.';
    }
    if (parsedDisplayOrder === null) {
      nextErrors.displayOrder = 'Display order must be a non-negative safe integer.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      if (nextErrors.name !== undefined) {
        nameRef.current?.focus();
      } else {
        displayOrderRef.current?.focus();
      }
      return;
    }

    if (category === null) {
      setErrors({});
      await onSubmit({
        description: normalizedDescription,
        display_order: parsedDisplayOrder as number,
        is_active: isActive,
        name: normalizedName,
      });
      return;
    }

    const payload: AdminCategoryUpdatePayload = {};
    if (normalizedName !== category.name) payload.name = normalizedName;
    if (normalizedDescription !== category.description) {
      payload.description = normalizedDescription;
    }
    if (parsedDisplayOrder !== category.displayOrder) {
      payload.display_order = parsedDisplayOrder as number;
    }
    if (isActive !== category.isActive) payload.is_active = isActive;
    if (Object.keys(payload).length === 0) {
      setErrors({ form: 'Change at least one category field before saving.' });
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
        <p className="eyebrow">Category editor</p>
        <h3>{category === null ? 'Add category' : 'Edit category'}</h3>
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
          Refresh categories before deliberately submitting this form again.
        </p>
      ) : null}
      <div className={styles.formGrid}>
        <label>
          Name
          <input
            ref={nameRef}
            aria-describedby={errors.name ? 'category-name-error' : undefined}
            aria-invalid={errors.name !== undefined}
            maxLength={121}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name !== undefined ? (
            <span className={styles.fieldError} id="category-name-error">
              {errors.name}
            </span>
          ) : null}
        </label>
        <label>
          Display order
          <input
            ref={displayOrderRef}
            inputMode="numeric"
            aria-describedby={
              errors.displayOrder ? 'category-display-order-error' : undefined
            }
            aria-invalid={errors.displayOrder !== undefined}
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
          />
          {errors.displayOrder !== undefined ? (
            <span className={styles.fieldError} id="category-display-order-error">
              {errors.displayOrder}
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
      </div>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        Active — visible in the public catalog when applicable
      </label>
      {showDiscardConfirmation ? (
        <Notice
          className={styles.discardConfirmation}
          title="Discard category changes?"
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
            disabled={submitLocked}
          >
            {category === null ? 'Create category' : 'Save changes'}
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

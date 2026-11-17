import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { fetchMenu } from '../../api/customerApi';
import type { MenuItem, MenuResponse } from '../../api/types';
import AsyncNotice from '../../components/AsyncNotice';
import Button from '../../components/ui/Button';
import { resolveMenuImage } from '../menu/menuImageCatalog';
import styles from './DemoMenuSandbox.module.css';

const LOCAL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const LOCAL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SANDBOX_IMAGE_SIZES =
  '(min-width: 64rem) 14rem, (min-width: 48rem) 35vw, calc(100vw - 4rem)';

interface SandboxMenuItem extends MenuItem {
  hidden_in_preview: boolean;
  localImageError: string | null;
  localImageUrl: string | null;
  priceDraft: string;
}

interface SandboxCategory {
  id: string;
  items: SandboxMenuItem[];
  name: string;
}

type SandboxState =
  | { kind: 'error' }
  | { kind: 'idle' }
  | { kind: 'loaded'; categories: SandboxCategory[]; original: SandboxCategory[] }
  | { kind: 'loading' };

interface SandboxContextValue {
  addSampleDish: (categoryId: string) => void;
  ensureLoaded: () => void;
  reset: () => void;
  selectLocalImage: (categoryId: string, itemId: string, file: File | null) => void;
  state: SandboxState;
  updateItem: (
    categoryId: string,
    itemId: string,
    patch: Partial<SandboxMenuItem>,
  ) => void;
}

const DemoMenuSandboxContext = createContext<SandboxContextValue | null>(null);

function cloneCategories(categories: SandboxCategory[]): SandboxCategory[] {
  return categories.map((category) => ({
    ...category,
    items: category.items.map((item) => ({ ...item, allergens: [...item.allergens] })),
  }));
}

function toSandboxCategories(menu: MenuResponse): SandboxCategory[] {
  return menu.categories.map((category) => ({
    id: category.id,
    name: category.name,
    items: category.items.map((item) => ({
      ...item,
      hidden_in_preview: false,
      localImageError: null,
      localImageUrl: null,
      priceDraft: (item.price_amount / 100).toFixed(2),
    })),
  }));
}

/** Keep menu-preview edits in memory for the lifetime of one demo admin shell. */
export function DemoMenuSandboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SandboxState>({ kind: 'idle' });
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeImageReadersRef = useRef<Map<string, FileReader>>(new Map());
  const sampleSequenceRef = useRef(0);
  const stateKindRef = useRef<SandboxState['kind']>('idle');

  const cancelLocalImageRead = useCallback((imageKey: string): void => {
    const reader = activeImageReadersRef.current.get(imageKey);
    if (reader === undefined) return;

    // Remove ownership first so a late event cannot update a newer preview.
    activeImageReadersRef.current.delete(imageKey);
    if (reader.readyState === FileReader.LOADING) {
      reader.abort();
    }
  }, []);

  const cancelAllLocalImageReads = useCallback((): void => {
    const readers = [...activeImageReadersRef.current.values()];
    activeImageReadersRef.current.clear();
    for (const reader of readers) {
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
    }
  }, []);

  const ensureLoaded = useCallback((): void => {
    if (stateKindRef.current === 'loading' || stateKindRef.current === 'loaded') {
      return;
    }
    const controller = new AbortController();
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;
    stateKindRef.current = 'loading';
    setState({ kind: 'loading' });
    void fetchMenu(controller.signal)
      .then((menu) => {
        if (controller.signal.aborted) return;
        const categories = toSandboxCategories(menu);
        stateKindRef.current = 'loaded';
        setState({
          categories: cloneCategories(categories),
          kind: 'loaded',
          original: cloneCategories(categories),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          stateKindRef.current = 'error';
          setState({ kind: 'error' });
        }
      })
      .finally(() => {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      });
  }, []);

  useEffect(
    () => () => {
      activeControllerRef.current?.abort();
      cancelAllLocalImageReads();
    },
    [cancelAllLocalImageReads],
  );

  const updateItem = useCallback(
    (categoryId: string, itemId: string, patch: Partial<SandboxMenuItem>): void => {
      setState((current) =>
        current.kind !== 'loaded'
          ? current
          : {
              ...current,
              categories: current.categories.map((category) =>
                category.id !== categoryId
                  ? category
                  : {
                      ...category,
                      items: category.items.map((item) =>
                        item.id === itemId ? { ...item, ...patch } : item,
                      ),
                    },
              ),
            },
      );
    },
    [],
  );

  const addSampleDish = useCallback((categoryId: string): void => {
    setState((current) => {
      if (current.kind !== 'loaded' || current.categories.length === 0) return current;
      const target = current.categories.find((category) => category.id === categoryId);
      if (target === undefined) return current;
      sampleSequenceRef.current += 1;
      const sample: SandboxMenuItem = {
        allergens: [],
        currency: target.items[0]?.currency ?? 'NOK',
        description: 'A browser-only sample dish for this menu preview.',
        display_order: target.items.length + 1,
        hidden_in_preview: false,
        id: `sandbox-sample-${sampleSequenceRef.current}`,
        image_url: null,
        is_available: true,
        localImageError: null,
        localImageUrl: null,
        name: `Sample dish ${sampleSequenceRef.current}`,
        price_amount: 15900,
        priceDraft: '159.00',
      };
      return {
        ...current,
        categories: current.categories.map((category) =>
          category.id === target.id
            ? { ...category, items: [...category.items, sample] }
            : category,
        ),
      };
    });
  }, []);

  const selectLocalImage = useCallback(
    (categoryId: string, itemId: string, file: File | null): void => {
      if (file === null) return;

      const imageKey = `${categoryId}:${itemId}`;
      cancelLocalImageRead(imageKey);

      if (!LOCAL_IMAGE_TYPES.has(file.type)) {
        updateItem(categoryId, itemId, {
          localImageError: 'Choose a JPEG, PNG, or WebP image.',
        });
        return;
      }
      if (file.size > LOCAL_IMAGE_MAX_BYTES) {
        updateItem(categoryId, itemId, {
          localImageError: 'Choose an image no larger than 5 MiB.',
        });
        return;
      }

      let reader: FileReader;
      try {
        reader = new FileReader();
      } catch {
        updateItem(categoryId, itemId, {
          localImageError: 'This image could not be prepared for the browser preview.',
        });
        return;
      }

      activeImageReadersRef.current.set(imageKey, reader);
      updateItem(categoryId, itemId, {
        localImageError: null,
      });

      reader.addEventListener('load', () => {
        if (activeImageReadersRef.current.get(imageKey) !== reader) return;
        activeImageReadersRef.current.delete(imageKey);
        const result = reader.result;
        if (
          typeof result !== 'string' ||
          !result.startsWith(`data:${file.type};base64,`)
        ) {
          updateItem(categoryId, itemId, {
            localImageError:
              'This image could not be prepared for the browser preview.',
          });
          return;
        }
        updateItem(categoryId, itemId, {
          localImageError: null,
          localImageUrl: result,
        });
      });
      reader.addEventListener('error', () => {
        if (activeImageReadersRef.current.get(imageKey) !== reader) return;
        activeImageReadersRef.current.delete(imageKey);
        updateItem(categoryId, itemId, {
          localImageError: 'This image could not be prepared for the browser preview.',
        });
      });
      reader.addEventListener('abort', () => {
        if (activeImageReadersRef.current.get(imageKey) === reader) {
          activeImageReadersRef.current.delete(imageKey);
        }
      });

      try {
        reader.readAsDataURL(file);
      } catch {
        if (activeImageReadersRef.current.get(imageKey) === reader) {
          activeImageReadersRef.current.delete(imageKey);
          updateItem(categoryId, itemId, {
            localImageError:
              'This image could not be prepared for the browser preview.',
          });
        }
      }
    },
    [cancelLocalImageRead, updateItem],
  );

  const reset = useCallback((): void => {
    cancelAllLocalImageReads();
    sampleSequenceRef.current = 0;
    setState((current) =>
      current.kind === 'loaded'
        ? { ...current, categories: cloneCategories(current.original) }
        : current,
    );
  }, [cancelAllLocalImageReads]);

  const value = useMemo(
    () => ({ addSampleDish, ensureLoaded, reset, selectLocalImage, state, updateItem }),
    [addSampleDish, ensureLoaded, reset, selectLocalImage, state, updateItem],
  );

  return (
    <DemoMenuSandboxContext.Provider value={value}>
      {children}
    </DemoMenuSandboxContext.Provider>
  );
}

function SandboxMenuImage({
  item,
  variant,
}: {
  item: SandboxMenuItem;
  variant: string;
}) {
  const resolvedImage =
    item.localImageUrl === null
      ? resolveMenuImage(item.id, item.image_url)
      : { kind: 'single' as const, src: item.localImageUrl };
  const imageUrl =
    resolvedImage?.kind === 'responsive'
      ? resolvedImage.asset.pngSrc
      : (resolvedImage?.src ?? null);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const showImage = imageUrl !== null && failedImageUrl !== imageUrl;

  return (
    <div className={styles.imageArea} data-variant={variant}>
      {showImage ? (
        resolvedImage?.kind === 'responsive' ? (
          <picture className={styles.picture}>
            <source
              type="image/webp"
              srcSet={resolvedImage.asset.webpSrcSet}
              sizes={SANDBOX_IMAGE_SIZES}
            />
            <img
              alt={`${item.name} preview`}
              className={styles.image}
              decoding="async"
              height={resolvedImage.asset.height}
              loading="lazy"
              src={resolvedImage.asset.pngSrc}
              width={resolvedImage.asset.width}
              onError={() => setFailedImageUrl(imageUrl)}
            />
          </picture>
        ) : (
          <img
            alt={`${item.name} preview`}
            className={styles.image}
            decoding="async"
            height={360}
            loading="lazy"
            src={imageUrl}
            width={480}
            onError={() => setFailedImageUrl(imageUrl)}
          />
        )
      ) : (
        <div
          className={styles.imagePlaceholder}
          role="img"
          aria-label={`${item.name} image unavailable`}
        >
          Image unavailable
        </div>
      )}
    </div>
  );
}

function useDemoMenuSandbox(): SandboxContextValue {
  const context = useContext(DemoMenuSandboxContext);
  if (context === null) throw new Error('DemoMenuSandbox requires its provider');
  return context;
}

function formatSandboxMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-NO', { currency, style: 'currency' }).format(
      amount / 100,
    );
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) throw error;
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

/** Render a browser-memory-only editor over the public menu snapshot. */
export default function DemoMenuSandbox() {
  const { addSampleDish, ensureLoaded, reset, selectLocalImage, state, updateItem } =
    useDemoMenuSandbox();

  useEffect(() => ensureLoaded(), [ensureLoaded]);

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <section aria-busy="true" aria-labelledby="menu-sandbox-heading">
        <h1 id="menu-sandbox-heading">Menu sandbox</h1>
        <AsyncNotice title="Loading public menu snapshot">
          Preparing a browser-only copy for preview.
        </AsyncNotice>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section aria-labelledby="menu-sandbox-heading">
        <h1 id="menu-sandbox-heading">Menu sandbox</h1>
        <AsyncNotice role="alert" title="Menu snapshot unavailable">
          The public menu could not be copied into this browser session.
        </AsyncNotice>
        <Button onClick={ensureLoaded} type="button" variant="secondary">
          Retry public menu
        </Button>
      </section>
    );
  }

  const visibleItems = state.categories.flatMap((category) =>
    category.items
      .filter((item) => item.is_available && !item.hidden_in_preview)
      .map((item) => ({ categoryName: category.name, item })),
  );

  return (
    <section className={styles.page} aria-labelledby="menu-sandbox-heading">
      <div className={styles.introduction}>
        <p className={styles.eyebrow}>Portfolio demo</p>
        <h1 id="menu-sandbox-heading">Menu sandbox</h1>
        <AsyncNotice title="Browser-only preview">
          This starts from the active public menu. Changes stay in this browser memory
          only and are discarded on refresh or logout. No catalog mutation is sent.
        </AsyncNotice>
        <div className={styles.actions}>
          <Button onClick={reset} type="button" variant="secondary">
            Reset to original menu
          </Button>
        </div>
      </div>

      <div className={styles.workspace}>
        <section className={styles.editor} aria-labelledby="sandbox-editor-heading">
          <h2 id="sandbox-editor-heading">Preview changes</h2>
          {state.categories.map((category) => (
            <section className={styles.category} key={category.id}>
              <div className={styles.categoryHeader}>
                <h3>{category.name}</h3>
                <Button
                  onClick={() => addSampleDish(category.id)}
                  type="button"
                  variant="secondary"
                >
                  Add dish to {category.name}
                </Button>
              </div>
              <div className={styles.itemGrid}>
                {category.items.map((item) => (
                  <fieldset className={styles.itemEditor} key={item.id}>
                    <legend>{item.name}</legend>
                    <SandboxMenuImage item={item} variant="editor" />
                    <label className={styles.fileLabel}>
                      Local preview image for {item.name}
                      <input
                        accept="image/jpeg,image/png,image/webp"
                        aria-describedby={`sandbox-image-help-${item.id}`}
                        type="file"
                        onChange={(event) => {
                          selectLocalImage(
                            category.id,
                            item.id,
                            event.currentTarget.files?.[0] ?? null,
                          );
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                    <p
                      className={styles.imageHelp}
                      id={`sandbox-image-help-${item.id}`}
                    >
                      JPEG, PNG, or WebP up to 5 MiB. Kept in browser memory only.
                    </p>
                    {item.localImageError === null ? null : (
                      <p className={styles.imageError} role="alert">
                        {item.localImageError}
                      </p>
                    )}
                    <label>
                      Name
                      <input
                        maxLength={120}
                        value={item.name}
                        onChange={(event) =>
                          updateItem(category.id, item.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        value={item.description ?? ''}
                        onChange={(event) =>
                          updateItem(category.id, item.id, {
                            description: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Price ({item.currency})
                      <input
                        inputMode="decimal"
                        min="0.01"
                        step="0.01"
                        type="number"
                        value={item.priceDraft}
                        onChange={(event) => {
                          const priceDraft = event.target.value;
                          const amount = Number(priceDraft);
                          updateItem(category.id, item.id, {
                            priceDraft,
                            ...(Number.isFinite(amount) && amount > 0
                              ? { price_amount: Math.round(amount * 100) }
                              : {}),
                          });
                        }}
                      />
                    </label>
                    <label className={styles.checkLabel}>
                      <input
                        checked={item.is_available}
                        type="checkbox"
                        onChange={(event) =>
                          updateItem(category.id, item.id, {
                            is_available: event.target.checked,
                          })
                        }
                      />
                      Available in preview
                    </label>
                    <label className={styles.checkLabel}>
                      <input
                        checked={item.hidden_in_preview}
                        type="checkbox"
                        onChange={(event) =>
                          updateItem(category.id, item.id, {
                            hidden_in_preview: event.target.checked,
                          })
                        }
                      />
                      Hide from preview
                    </label>
                  </fieldset>
                ))}
              </div>
            </section>
          ))}
        </section>

        <section className={styles.preview} aria-labelledby="sandbox-preview-heading">
          <h2 id="sandbox-preview-heading">Current browser preview</h2>
          {visibleItems.length === 0 ? (
            <p>No available dishes are visible in this preview.</p>
          ) : (
            <ul>
              {visibleItems.map(({ categoryName, item }) => (
                <li key={`${categoryName}-${item.id}`}>
                  <SandboxMenuImage item={item} variant="preview" />
                  <span>{categoryName}</span>
                  <strong>{item.name}</strong>
                  {item.description ? <p>{item.description}</p> : null}
                  <span>{formatSandboxMoney(item.price_amount, item.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

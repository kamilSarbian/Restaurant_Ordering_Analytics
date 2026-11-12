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
import styles from './DemoMenuSandbox.module.css';

interface SandboxMenuItem extends MenuItem {
  hidden_in_preview: boolean;
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
  addSampleDish: () => void;
  ensureLoaded: () => void;
  reset: () => void;
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
      priceDraft: (item.price_amount / 100).toFixed(2),
    })),
  }));
}

/** Keep menu-preview edits in memory for the lifetime of one demo admin shell. */
export function DemoMenuSandboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SandboxState>({ kind: 'idle' });
  const activeControllerRef = useRef<AbortController | null>(null);
  const sampleSequenceRef = useRef(0);
  const stateKindRef = useRef<SandboxState['kind']>('idle');

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
    },
    [],
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

  const addSampleDish = useCallback((): void => {
    setState((current) => {
      if (current.kind !== 'loaded' || current.categories.length === 0) return current;
      sampleSequenceRef.current += 1;
      const target = current.categories[0];
      if (target === undefined) return current;
      const sample: SandboxMenuItem = {
        allergens: [],
        currency: target.items[0]?.currency ?? 'NOK',
        description: 'A browser-only sample dish for this menu preview.',
        display_order: target.items.length + 1,
        hidden_in_preview: false,
        id: `sandbox-sample-${sampleSequenceRef.current}`,
        image_url: null,
        is_available: true,
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

  const reset = useCallback((): void => {
    sampleSequenceRef.current = 0;
    setState((current) =>
      current.kind === 'loaded'
        ? { ...current, categories: cloneCategories(current.original) }
        : current,
    );
  }, []);

  const value = useMemo(
    () => ({ addSampleDish, ensureLoaded, reset, state, updateItem }),
    [addSampleDish, ensureLoaded, reset, state, updateItem],
  );

  return (
    <DemoMenuSandboxContext.Provider value={value}>
      {children}
    </DemoMenuSandboxContext.Provider>
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
  const { addSampleDish, ensureLoaded, reset, state, updateItem } =
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
          <Button onClick={addSampleDish} type="button">
            Add sample dish
          </Button>
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
              <h3>{category.name}</h3>
              <div className={styles.itemGrid}>
                {category.items.map((item) => (
                  <fieldset className={styles.itemEditor} key={item.id}>
                    <legend>{item.name}</legend>
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

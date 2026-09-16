import type { MenuCategory } from '../../api/types';
import MenuItemCard from './MenuItemCard';
import styles from './MenuPage.module.css';

interface MenuCategorySectionProps {
  category: MenuCategory;
  prioritizeFirstItem?: boolean;
}

/** Render an ordered menu category and propagate first-card image priority. */
export default function MenuCategorySection({
  category,
  prioritizeFirstItem = false,
}: MenuCategorySectionProps) {
  const headingId = 'category-' + category.id;

  return (
    <section className={styles.categorySection} aria-labelledby={headingId}>
      <header className={styles.categoryHeader}>
        <div className={styles.categoryTitleRow}>
          <h2 className={styles.categoryHeading} id={headingId}>
            {category.name}
          </h2>
          <span className={styles.itemCount}>
            {category.items.length} {category.items.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        {category.description !== null && (
          <p className={styles.categoryDescription}>{category.description}</p>
        )}
      </header>
      <div className={styles.itemGrid}>
        {category.items.map((item, itemIndex) => (
          <MenuItemCard
            item={item}
            priority={prioritizeFirstItem && itemIndex === 0}
            key={item.id}
          />
        ))}
      </div>
    </section>
  );
}

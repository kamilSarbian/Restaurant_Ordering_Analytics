import type { MenuCategory } from '../../api/types';
import MenuItemCard from './MenuItemCard';
import styles from './MenuPage.module.css';

interface MenuCategorySectionProps {
  category: MenuCategory;
}

export default function MenuCategorySection({ category }: MenuCategorySectionProps) {
  const headingId = `category-${category.id}`;

  return (
    <section aria-labelledby={headingId}>
      <header className={styles.categoryHeader}>
        <h2 className={styles.categoryHeading} id={headingId}>
          {category.name}
        </h2>
        {category.description !== null && (
          <p className={styles.categoryDescription}>{category.description}</p>
        )}
      </header>
      <div className={styles.itemGrid}>
        {category.items.map((item) => (
          <MenuItemCard item={item} key={item.id} />
        ))}
      </div>
    </section>
  );
}

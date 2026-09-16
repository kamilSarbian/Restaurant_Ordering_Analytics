const LOCAL_MENU_IMAGE_PREFIX = '/images/menu/';
const OPTIMIZED_MENU_IMAGE_PREFIX = `${LOCAL_MENU_IMAGE_PREFIX}optimized/`;

export const MENU_IMAGE_SIZES =
  '(min-width: 76rem) calc(23.167rem - 2px), (min-width: 64rem) calc(33.333vw - 2.167rem - 2px), (min-width: 48rem) calc(50vw - 2.625rem - 2px), (min-width: 40rem) calc(50vw - 1.625rem - 2px), calc(100vw - 2rem - 2px)';

export interface MenuImageCatalogAsset {
  readonly aspectRatio: '4 / 3';
  readonly height: 1086;
  readonly pngSrc: string;
  readonly webp1080Src: string;
  readonly webp480Src: string;
  readonly webp720Src: string;
  readonly webpSrcSet: string;
  readonly width: 1448;
}

export type ResolvedMenuImage =
  | { readonly asset: MenuImageCatalogAsset; readonly kind: 'responsive' }
  | { readonly kind: 'single'; readonly src: string };

function createMenuImageCatalogAsset(
  category: string,
  fileStem: string,
): MenuImageCatalogAsset {
  const pngSrc = `${LOCAL_MENU_IMAGE_PREFIX}${category}/${fileStem}.png`;
  const optimizedBase = `${OPTIMIZED_MENU_IMAGE_PREFIX}${category}/${fileStem}`;
  const webp480Src = `${optimizedBase}-480w.webp`;
  const webp720Src = `${optimizedBase}-720w.webp`;
  const webp1080Src = `${optimizedBase}-1080w.webp`;

  return Object.freeze({
    aspectRatio: '4 / 3',
    height: 1086,
    pngSrc,
    webp1080Src,
    webp480Src,
    webp720Src,
    webpSrcSet: `${webp480Src} 480w, ${webp720Src} 720w, ${webp1080Src} 1080w`,
    width: 1448,
  });
}

export const MENU_IMAGE_CATALOG: Readonly<Record<string, MenuImageCatalogAsset>> =
  Object.freeze({
    '372b82fc-dd0c-465e-ae9a-7b585d03f7c7': createMenuImageCatalogAsset(
      'starters',
      'Roasted-Root-Vegetable-Soup',
    ),
    '9a5225fd-c749-4d26-99d6-965267b0ce26': createMenuImageCatalogAsset(
      'starters',
      'Smoked-Salmon-Toast',
    ),
    '90bec893-ece6-40bb-886e-45e1a640f980': createMenuImageCatalogAsset(
      'starters',
      'Crispy-Cauliflower',
    ),
    'e3fd81c3-0fe6-4e7a-8e1d-2fdf413222ff': createMenuImageCatalogAsset(
      'main_courses',
      'Pan-Seared-Cod',
    ),
    'f870c8df-510e-43a4-8b69-e8b6d5e5db2c': createMenuImageCatalogAsset(
      'main_courses',
      'Nordic-Chicken-Plate',
    ),
    'a10c4ba3-57a3-43da-8be7-c2d52ab1e7fa': createMenuImageCatalogAsset(
      'main_courses',
      'Mushroom-Barley-Bowl',
    ),
    '9933957b-7f5d-47d8-84c3-ba8ad21b2d8c': createMenuImageCatalogAsset(
      'burgers',
      'Classic-Beef-Burger',
    ),
    '34157d9d-2123-4e75-acde-4f513da73bcb': createMenuImageCatalogAsset(
      'burgers',
      'Fjord-Fish-Burger',
    ),
    'e7aafb70-8bbd-4280-bdba-bd503dc884ac': createMenuImageCatalogAsset(
      'burgers',
      'Plant-Burger',
    ),
    '95abd9ff-dea5-48fa-aa81-0632fb5caef7': createMenuImageCatalogAsset(
      'desserts',
      'Warm-Apple-Cake',
    ),
    'c0ec6110-60ab-49bf-bc6f-13eda579fb1a': createMenuImageCatalogAsset(
      'desserts',
      'Dark-Chocolate-Mousse',
    ),
    'f6448f8c-db21-4096-903a-facafc5a729c': createMenuImageCatalogAsset(
      'desserts',
      'Vanilla-Panna-Cotta',
    ),
    'c496b9cc-268c-4549-9e36-e8225e57561f': createMenuImageCatalogAsset(
      'non_alcohol_drinks',
      'Cloudberry-Spritz',
    ),
    '99655656-bab2-4844-8557-6d73d1d4c07a': createMenuImageCatalogAsset(
      'non_alcohol_drinks',
      'Norwegian-Apple-Juice',
    ),
    'a80988ed-27ae-4470-a768-25109a16963a': createMenuImageCatalogAsset(
      'non_alcohol_drinks',
      'Sparkling-Water',
    ),
  });

/** Return whether a root-relative URL is confined to the local menu image tree. */
export function isSafeLocalMenuImageUrl(imageUrl: string): boolean {
  if (
    !imageUrl.startsWith(LOCAL_MENU_IMAGE_PREFIX) ||
    imageUrl.length === LOCAL_MENU_IMAGE_PREFIX.length ||
    imageUrl.includes('..') ||
    imageUrl.includes('//') ||
    /[\s\\%?#]/u.test(imageUrl)
  ) {
    return false;
  }

  return imageUrl
    .slice(LOCAL_MENU_IMAGE_PREFIX.length)
    .split('/')
    .every((segment) => segment.length > 0);
}

function hasSafeCatalogUrls(asset: MenuImageCatalogAsset): boolean {
  return [asset.pngSrc, asset.webp480Src, asset.webp720Src, asset.webp1080Src].every(
    isSafeLocalMenuImageUrl,
  );
}

/** Return a responsive catalog asset for an exact menu item UUID, or null. */
export function getCatalogMenuImageAsset(
  menuItemId: string,
): MenuImageCatalogAsset | null {
  if (!Object.hasOwn(MENU_IMAGE_CATALOG, menuItemId)) {
    return null;
  }

  const asset = MENU_IMAGE_CATALOG[menuItemId];
  return asset !== undefined && hasSafeCatalogUrls(asset) ? asset : null;
}

/** Return a catalog PNG URL for an exact menu item UUID, or null when unknown. */
export function getCatalogMenuImageUrl(menuItemId: string): string | null {
  return getCatalogMenuImageAsset(menuItemId)?.pngSrc ?? null;
}

/** Validate an API-provided external or same-origin menu image URL. */
export function getSafeMenuImageUrl(imageUrl: string | null): string | null {
  if (imageUrl === null) {
    return null;
  }
  if (isSafeLocalMenuImageUrl(imageUrl)) {
    return imageUrl;
  }

  try {
    const parsedUrl = new URL(imageUrl);
    return ['http:', 'https:'].includes(parsedUrl.protocol) ? parsedUrl.href : null;
  } catch {
    return null;
  }
}

/** Resolve a safe single image or an exact UUID-backed responsive catalog asset. */
export function resolveMenuImage(
  menuItemId: string,
  apiImageUrl: string | null,
): ResolvedMenuImage | null {
  const catalogAsset = getCatalogMenuImageAsset(menuItemId);
  const safeApiImageUrl = getSafeMenuImageUrl(apiImageUrl);

  if (safeApiImageUrl !== null) {
    if (catalogAsset !== null && safeApiImageUrl === catalogAsset.pngSrc) {
      return { asset: catalogAsset, kind: 'responsive' };
    }
    return { kind: 'single', src: safeApiImageUrl };
  }

  return catalogAsset === null ? null : { asset: catalogAsset, kind: 'responsive' };
}

/** Resolve a menu image URL without allowing the catalog to override a valid API URL. */
export function resolveMenuImageUrl(
  menuItemId: string,
  apiImageUrl: string | null,
): string | null {
  const resolvedImage = resolveMenuImage(menuItemId, apiImageUrl);
  if (resolvedImage === null) {
    return null;
  }
  return resolvedImage.kind === 'responsive'
    ? resolvedImage.asset.pngSrc
    : resolvedImage.src;
}

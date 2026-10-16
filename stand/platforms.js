// Особенности площадок: как устроены страницы отзывов и где искать товар.
// Поиск по площадке используется только если robots.txt его разрешает — это проверяет сборщик.

// следующая страница списка отзывов
export function pageUrl(platform, base, n) {
  if (n <= 1) return base;
  if (platform === "otzovik") return base.replace(/\/?$/, "/") + `${n}/`;
  const u = new URL(base); u.searchParams.set("page", String(n)); return u.href;
}

// адрес поиска товара на площадке — если у товара нет прямого адреса
export function searchUrl(platform, product) {
  const q = encodeURIComponent(product.model || product.title);
  return {
    market: `https://market.yandex.ru/search?text=${q}`,
    ozon: `https://www.ozon.ru/search/?text=${q}`,
    wildberries: `https://www.wildberries.ru/catalog/0/search.aspx?search=${q}`,
    mvideo: `https://www.mvideo.ru/product-list-page?q=${q}`,
    irecommend: `https://irecommend.ru/srch?query=${q}`,
  }[platform] || null;
}

// otzovik: ссылки на страницы отдельных отзывов (полный текст) со страницы товара
export function otzovikReviewLinks(html) {
  return [...new Set([...String(html).matchAll(/href="((?:https?:\/\/otzovik\.com)?\/review_\d+\.html)"/g)].map((m) => new URL(m[1], "https://otzovik.com").href))];
}

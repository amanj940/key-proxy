(() => {
  const languageKey = 'keyproxy-lang';
  let translations = {};
  const translationCache = {};

  function lookup(key) {
    return key.split('.').reduce((value, part) => value?.[part], translations) ?? key;
  }

  window.pageT = (key, values = {}) => String(lookup(key)).replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] ?? '');

  function applyLanguage(nextLanguage) {
    const isArabic = nextLanguage === 'ar';
    document.documentElement.lang = nextLanguage;
    document.documentElement.dir = isArabic ? 'rtl' : 'ltr';

    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = window.pageT(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
      element.placeholder = window.pageT(element.dataset.i18nPlaceholder);
    }
    for (const element of document.querySelectorAll('[data-i18n-title]')) {
      element.title = window.pageT(element.dataset.i18nTitle);
    }

    const titleKey = document.body.dataset.titleKey;
    if (titleKey) document.title = window.pageT(titleKey);

    const toggle = document.getElementById('languageToggle');
    if (toggle) {
      toggle.textContent = isArabic ? 'English' : 'العربية';
      toggle.setAttribute('aria-label', isArabic ? 'Switch language to English' : 'تغيير اللغة إلى العربية');
      toggle.onclick = () => {
        const selected = isArabic ? 'en' : 'ar';
        setLanguage(selected);
      };
    }

    localStorage.setItem(languageKey, nextLanguage);
    window.currentPageLanguage = nextLanguage;
  }

  async function setLanguage(nextLanguage) {
    try {
      if (!translationCache[nextLanguage]) {
        const response = await fetch(`/locales/${nextLanguage}.json`);
        if (!response.ok) throw new Error(`Locale request failed: ${response.status}`);
        translationCache[nextLanguage] = await response.json();
      }
      translations = translationCache[nextLanguage].translation.pages || {};
    } catch (error) {
      console.error('Unable to load page translations', error);
    }
    applyLanguage(nextLanguage);
  }

  async function initialize() {
    await setLanguage(localStorage.getItem(languageKey) === 'en' ? 'en' : 'ar');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
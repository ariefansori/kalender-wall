/**
 * Accordion for the left control panel: exactly one section stays open, so the
 * sidebar never turns into a wall of stacked controls.
 */
export function initAccordion(root = document) {
  const sections = [...root.querySelectorAll('[data-acc]')];
  if (!sections.length) return;
  const setOpen = (target) => {
    for (const section of sections) {
      const open = section === target;
      section.classList.toggle('is-open', open);
      const head = section.querySelector('.acc-head');
      if (head) head.setAttribute('aria-expanded', String(open));
    }
  };

  for (const section of sections) {
    const head = section.querySelector('.acc-head');
    if (!head) continue;
    head.addEventListener('click', () => {
      const wasOpen = section.classList.contains('is-open');
      setOpen(wasOpen ? null : section);
    });
  }

  const firstOpen = sections.find((section) => section.classList.contains('is-open')) || sections[0];
  setOpen(firstOpen);
}

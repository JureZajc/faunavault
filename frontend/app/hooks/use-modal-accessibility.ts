"use client";

import {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  useEffect,
  useRef,
} from "react";

type ModalAccessibilityOptions = {
  isOpen: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  isBusy?: boolean;
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

let scrollLockCount = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0 && previousBodyOverflow !== null) {
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
  }
}

function isVisible(element: HTMLElement) {
  if (
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function getFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      isVisible(element),
  );
}

function restoreFocus(
  previousFocus: HTMLElement | null,
  fallbackFocus: HTMLElement | null,
  surroundingFocus: HTMLElement[],
) {
  queueMicrotask(() => {
    const canReceiveFocus = (element: HTMLElement | null) =>
      Boolean(
        element?.isConnected &&
        !(element instanceof HTMLButtonElement && element.disabled) &&
        !(element instanceof HTMLInputElement && element.disabled) &&
        !(element instanceof HTMLSelectElement && element.disabled) &&
        !(element instanceof HTMLTextAreaElement && element.disabled) &&
        element?.getAttribute("aria-disabled") !== "true" &&
        isVisible(element as HTMLElement),
      );
    let target = canReceiveFocus(previousFocus)
      ? previousFocus
      : canReceiveFocus(fallbackFocus)
        ? fallbackFocus
        : surroundingFocus.find(canReceiveFocus) ?? null;

    if (!target && previousFocus?.isConnected) {
      let context = previousFocus.parentElement;
      while (context && context !== document.body && !target) {
        target = getFocusableElements(context)[0] ?? null;
        context = context.parentElement;
      }
    }
    if (!target) return;

    const openDialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
    );
    if (
      openDialogs.length > 0 &&
      !openDialogs.some((dialog) => dialog.contains(target))
    ) {
      return;
    }

    target.focus({ preventScroll: true });
  });
}

export function useModalAccessibility({
  isOpen,
  dialogRef,
  initialFocusRef,
  fallbackFocusRef,
  onClose,
  isBusy = false,
}: ModalAccessibilityOptions) {
  const onCloseRef = useRef(onClose);
  const isBusyRef = useRef(isBusy);

  useEffect(() => {
    onCloseRef.current = onClose;
    isBusyRef.current = isBusy;
  }, [isBusy, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const fallbackFocus = fallbackFocusRef?.current ?? null;
    lockBodyScroll();

    const dialog = dialogRef.current;
    const initialFocus = initialFocusRef?.current;
    const pageFocusables = getFocusableElements(document.body).filter(
      (element) => !dialog?.contains(element),
    );
    const previousIndex = previousFocus
      ? pageFocusables.indexOf(previousFocus)
      : -1;
    const surroundingFocus =
      previousIndex >= 0
        ? [
            ...pageFocusables.slice(0, previousIndex).reverse(),
            ...pageFocusables.slice(previousIndex + 1),
          ]
        : pageFocusables;
    (initialFocus && isVisible(initialFocus) ? initialFocus : dialog)?.focus({
      preventScroll: true,
    });

    return () => {
      unlockBodyScroll();
      restoreFocus(previousFocus, fallbackFocus, surroundingFocus);
    };
  }, [dialogRef, fallbackFocusRef, initialFocusRef, isOpen]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!isBusyRef.current) onCloseRef.current();
      return;
    }

    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    const activeIndex = focusable.indexOf(activeElement as HTMLElement);

    if (event.shiftKey && (activeIndex <= 0 || !dialog.contains(activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (activeIndex === -1 ||
        activeIndex === focusable.length - 1 ||
        !dialog.contains(activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  return { handleKeyDown };
}

import { useState, useEffect } from 'react';

/**
 * Hook to track page visibility state using the Page Visibility API.
 * Returns true when the page is visible (user is actively viewing the tab),
 * false when the tab is in the background or minimized.
 *
 * This is useful for features like read receipts - we shouldn't mark messages
 * as "read" when the user has the chat open in a background tab.
 *
 * @example
 * ```tsx
 * const isVisible = usePageVisibility();
 *
 * useEffect(() => {
 *   if (isVisible && unreadMessages.length > 0) {
 *     markAsRead(unreadMessages.map(m => m.id));
 *   }
 * }, [isVisible, unreadMessages]);
 * ```
 */
export function usePageVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(() => {
    // Default to true for SSR, will be corrected on mount
    if (typeof document === 'undefined') return true;
    return !document.hidden;
  });

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    // Set initial state
    setIsVisible(!document.hidden);

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}

export default usePageVisibility;

import { useEffect, useRef } from 'react';

// A ref for a heading (tabIndex -1). Focus moves to it when `condition` turns true after the first render, so the
// control that was focused (and has just been replaced) doesn't leave keyboard and screen-reader users on nothing.
export function useFocusWhen(condition) {
  const ref = useRef(null);
  const was = useRef(condition);
  useEffect(() => {
    if (condition && !was.current) ref.current?.focus({ preventScroll: true });
    was.current = condition;
  }, [condition]);
  return ref;
}

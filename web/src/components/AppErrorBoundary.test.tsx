// @vitest-environment jsdom
//
// Scoped to this file on purpose: every other web suite is pure logic and stays
// in the faster Node environment. An error boundary cannot be proven any other
// way — `renderToString` never invokes getDerivedStateFromError, so only a real
// client render exercises the behaviour this file is here to guarantee.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppErrorBoundary } from './AppErrorBoundary';

/**
 * Deliberately shaped like the things that must never reach a user: a
 * salary-bearing value, an employee id, and an internal component name. If the
 * fallback ever printed `error.message`, these assertions break.
 */
const SECRET = 'SALARY-42000-employee-8831';

function Boom(): never {
  throw new Error(`${SECRET} failed in PayrollTable.render`);
}

function Safe() {
  return <p>payroll loaded</p>;
}

describe('AppErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // React logs every caught render error itself. Silence the noise, but keep
    // the calls recorded so the "did not fail silently" assertion can see them.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
    document.documentElement.lang = '';
  });

  it('renders children untouched when nothing throws', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Safe />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('payroll loaded');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('catches a render-time throw and shows recovery UI instead of a blank screen', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    // The blocker this closes is "a render-time throw blanks the app", so the
    // meaningful assertion is that something usable is still on screen.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBeTruthy();
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
  });

  it('never exposes the exception text, stack, or component name', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    // innerHTML as well as textContent: a leak via a title/aria attribute would
    // be just as damaging as visible text.
    expect(container.textContent ?? '').not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain('PayrollTable');
    expect(container.innerHTML).not.toContain('.render');
  });

  it('recovers through the retry action when the child stops throwing', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error(`${SECRET} transient`);
      return <p>payroll loaded</p>;
    }

    act(() => {
      root.render(
        <AppErrorBoundary>
          <Flaky />
        </AppErrorBoundary>,
      );
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    shouldThrow = false;
    const retry = container.querySelectorAll('button')[0];
    act(() => {
      retry.click();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('payroll loaded');
  });

  it('reloads the document from the secondary action', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });

    try {
      act(() => {
        root.render(
          <AppErrorBoundary>
            <Boom />
          </AppErrorBoundary>,
        );
      });

      const reloadButton = container.querySelectorAll('button')[1];
      act(() => {
        reloadButton.click();
      });

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('shows an opaque support reference and does not fail silently', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    // Opaque by construction: random, and carrying nothing about the account.
    expect(container.textContent ?? '').toMatch(/[0-9A-Z]{8}/);
    expect(consoleError).toHaveBeenCalled();
  });

  it('follows the document language for the fallback copy', () => {
    document.documentElement.lang = 'en';

    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('Something went wrong');
  });

  it('falls back to Arabic when the document language was never set', () => {
    // App mirrors its locale onto <html lang> from an effect, which never runs
    // if App itself throws on first render. Arabic is the app default, so the
    // fallback must still be readable rather than silently switching language.
    expect(document.documentElement.lang).toBe('');

    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('حدث خطأ غير متوقع');
  });

  it('notifies a provider-neutral reporter with only the reference', () => {
    const onError = vi.fn();

    act(() => {
      root.render(
        <AppErrorBoundary onError={onError}>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [reference] = onError.mock.calls[0] as [string];
    expect(reference).toMatch(/^[0-9A-Z]{8}$/);
    expect(reference).not.toContain(SECRET);
  });
});

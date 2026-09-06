import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * The last thing between a thrown render and a white page.
 *
 * There was nothing here before, and React 18 unmounts the entire tree when a
 * render throws — so any one of the several dozen places this app formats a
 * date, reads a field off a response or indexes an array could take the whole
 * site down to a blank document with a stack trace in a console nobody on a
 * phone can open. That is not a hypothetical: `new Intl.DateTimeFormat()` on a
 * locale built by hand out of an empty language column throws a RangeError from
 * inside render, and it did so on three screens in the operator app.
 *
 * WHAT IT IS ALLOWED TO SAY. Nothing about what went wrong. The message a
 * JavaScript error carries is written for whoever wrote the code, and printing
 * "Cannot read properties of undefined" at somebody trying to find out when
 * their van is coming tells them nothing and reads as though their data is
 * gone. What it does instead is give them the two things that actually recover
 * from this — reload the page they are on, or go to the front page — because
 * one of the two nearly always works and neither requires understanding
 * anything.
 *
 * It deliberately does NOT reset itself on a route change. A boundary that
 * quietly re-renders a subtree that has just thrown loops: the same render
 * throws again, and the page flickers between the error and nothing. Reloading
 * is the honest way out and it is the button.
 */
interface State { failed: boolean }

export default class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place this can go — there is no error reporting
    // service wired up — and it is worth keeping, because the alternative is a
    // reproducible crash with no record of it anywhere at all.
    console.error('Render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="centre">
        <div className="auth stack">
          <h1 className="as-h2">This page stopped working</h1>
          <p className="muted" style={{ margin: 0 }}>
            Something went wrong drawing it. Nothing you did caused it and
            nothing you had entered has been sent anywhere.
          </p>
          <button className="btn block" type="button"
            onClick={() => window.location.reload()}>
            Reload this page
          </button>
          {/* A plain <a>, not a <Link>: the router is inside the subtree that
              just failed, so navigating within it would re-render the thing
              that threw. This asks the browser for a whole new document. */}
          <a className="btn quiet block" href="/">Go to the front page</a>
        </div>
      </div>
    );
  }
}

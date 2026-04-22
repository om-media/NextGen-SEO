import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';

// I need to test this in browser, so I'll edit the actual code to `console.log(result)` and ask the user to test?
// Actually, I can't ask the user. I have to just build a robust OAuth flow.

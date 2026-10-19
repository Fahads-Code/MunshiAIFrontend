import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCCcaQDTXLNUyQRJnOx_5U_Fm6aUggkMpE",
  authDomain: "munshi-ai-fab19.firebaseapp.com",
  projectId: "munshi-ai-fab19",
  messagingSenderId: "883593025168",
  appId: "1:883593025168:web:f09777e448dca0cd502a15",
  measurementId: "G-4QJT02NGTC",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});
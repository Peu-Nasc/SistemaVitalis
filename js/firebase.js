// Importações do Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// Lê o endereço que o cliente digitou no navegador
const host = window.location.hostname;
let firebaseConfig;

// ROTEAMENTO DE BANCO DE DADOS POR SUBDOMÍNIO
if (host === 'elisangela.sistemavitalis.com.br') {
    
    // Removi a palavra "const" daqui!
    firebaseConfig = {
        apiKey: "AIzaSyAUL4a9jX__kx2dR-dZioalQxM7QxZPSl0",
        authDomain: "vitalis---elisangela.firebaseapp.com",
        projectId: "vitalis---elisangela",
        storageBucket: "vitalis---elisangela.firebasestorage.app",
        messagingSenderId: "527275326414",
        appId: "1:527275326414:web:d9bc13089c42f5d783499f"
    };
    console.log("Conectado ao banco: Clínica Elisangela");

} else if (host === 'daniel.sistemavitalis.com.br') {
    
    // Removi a palavra "const" daqui!
    firebaseConfig = {
        apiKey: "AIzaSyCF_cc8t8cqB1iYjKku1r7pzIJa5d0029U",
        authDomain: "vitalis---daniel.firebaseapp.com",
        projectId: "vitalis---daniel",
        storageBucket: "vitalis---daniel.firebasestorage.app",
        messagingSenderId: "266266312840",
        appId: "1:266266312840:web:0e0ce38a1c597898009f3d"
    };
    console.log("Conectado ao banco: Clínica Dr. Daniel");

} else {
    
    // AMBIENTE DE DESENVOLVIMENTO (VSCode / Localhost / Domínio Raiz)
    // Usando a chave da Elisangela como padrão para você conseguir testar no seu PC
    firebaseConfig = {
  apiKey: "AIzaSyD0IiMD48j88dVv2XAnRIItJjoTEITEMiw",
  authDomain: "clinicamed-69b57.firebaseapp.com",
  projectId: "clinicamed-69b57",
  storageBucket: "clinicamed-69b57.firebasestorage.app",
  messagingSenderId: "887597358188",
  appId: "1:887597358188:web:80602df42ef4039fb90c49"
};
    console.log("Conectado ao banco: Ambiente Local/Teste");
}

// Inicializa o Firebase com a chave correta escolhida acima
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app); // <- Adicione esta linha!

// Exporte o storage também!
export { app, db, auth, storage };
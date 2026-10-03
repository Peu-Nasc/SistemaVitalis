// Importações do Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// ROTEAMENTO DE BANCO DE DADOS POR SUBDOMÍNIO
// (as chaves do Firebase Web são públicas por natureza: quem protege os
// dados são as regras do Firestore/Storage, não o sigilo dessas chaves)
const CONFIGS_POR_DOMINIO = {
    'elisangela.sistemavitalis.com.br': {
        apiKey: "AIzaSyAUL4a9jX__kx2dR-dZioalQxM7QxZPSl0",
        authDomain: "vitalis---elisangela.firebaseapp.com",
        projectId: "vitalis---elisangela",
        storageBucket: "vitalis---elisangela.firebasestorage.app",
        messagingSenderId: "527275326414",
        appId: "1:527275326414:web:d9bc13089c42f5d783499f"
    },
    'daniel.sistemavitalis.com.br': {
        apiKey: "AIzaSyCF_cc8t8cqB1iYjKku1r7pzIJa5d0029U",
        authDomain: "vitalis---daniel.firebaseapp.com",
        projectId: "vitalis---daniel",
        storageBucket: "vitalis---daniel.firebasestorage.app",
        messagingSenderId: "266266312840",
        appId: "1:266266312840:web:0e0ce38a1c597898009f3d"
    }
};

// AMBIENTE DE TESTES E DEMONSTRAÇÃO (Sandbox)
const CONFIG_TESTE = {
    apiKey: "AIzaSyD0IiMD48j88dVv2XAnRIItJjoTEITEMiw",
    authDomain: "clinicamed-69b57.firebaseapp.com",
    projectId: "clinicamed-69b57",
    storageBucket: "clinicamed-69b57.firebasestorage.app",
    messagingSenderId: "887597358188",
    appId: "1:887597358188:web:80602df42ef4039fb90c49"
};
const DOMINIOS_DE_TESTE = ['teste.sistemavitalis.com.br', 'localhost', '127.0.0.1'];

const host = window.location.hostname;
const firebaseConfig = CONFIGS_POR_DOMINIO[host]
    || (DOMINIOS_DE_TESTE.includes(host) ? CONFIG_TESTE : null);

// DOMÍNIO NÃO MAPEADO: não inicializa nada (e principalmente não cai
// silenciosamente no banco de outra clínica ou de testes). Mostra um aviso
// e interrompe o carregamento do sistema.
if (!firebaseConfig) {
    document.body.innerHTML = `
        <div style="font-family:sans-serif; max-width:480px; margin:15vh auto; padding:24px; text-align:center;">
            <h2>Endereço não autorizado</h2>
            <p>Este endereço não está habilitado para acessar o sistema.
               Use o link fornecido pela sua clínica ou fale com o suporte.</p>
        </div>`;
    throw new Error(`Domínio não autorizado: ${host}`);
}

// Inicializa o Firebase com a chave correta escolhida acima
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

export { app, db, auth, storage };
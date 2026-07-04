import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';

// Tentukan path ke root folder
const BASE_DIR = path.resolve(__dirname, '..');
const RAW_FILE = path.join(BASE_DIR, 'rawProxyList.txt');
const LIST_FILE = path.join(BASE_DIR, 'ProxyList.txt');
const KV_FILE = path.join(BASE_DIR, 'KvProxyList.json');
const OUTPUT_FILE = path.join(BASE_DIR, 'output.txt'); // File baru untuk append tanpa duplikat

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

function getRandomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

interface ProxyData {
    ip: string;
    port: number;
    inputIsp: string;
    raw: string;
}

interface ActiveResult {
    ip: string;
    port: number;
    delay: number;
    country: string;
    colo: string;
    isp: string;
}

// --- FUNGSI SMART PARSER ---
function extractIpPort(line: string): ProxyData | null {
    line = line.trim();
    if (!line) return null;
    
    const parts = line.split(',').map(p => p.trim());
    const match = parts[0].match(/^([a-zA-Z0-9.\-]+)(?:\s*[:,\-]\s*)(\d+)/);
    
    let ip: string | null = null;
    let port: string | null = null;
    
    if (match) {
        ip = match[1];
        port = match[2];
    } else if (parts.length >= 2 && !isNaN(Number(parts[1]))) {
        ip = parts[0];
        port = parts[1];
    }
    
    if (ip && port) {
        let isp = "-";
        if (parts.length >= 3 && isNaN(Number(parts[parts.length - 1]))) {
            isp = parts[parts.length - 1].replace(/["']/g, '');
        }
        return { ip, port: parseInt(port), inputIsp: isp, raw: `${ip}:${port}` };
    }
    return null;
}

// --- ROTASI API ISP ---
async function getIspGeo(ipAddress: string): Promise<string> {
    try {
        const res = await fetch(`http://ip-api.com/json/${ipAddress}?fields=isp,as`, {
            headers: { 'User-Agent': getRandomUA() },
            signal: AbortSignal.timeout(3000)
        });
        const geo = await res.json();
        return geo.isp || geo.as || "-";
    } catch {
        try {
            const res = await fetch(`http://ipwho.is/${ipAddress}`, {
                headers: { 'User-Agent': getRandomUA() },
                signal: AbortSignal.timeout(3000)
            });
            const geo = await res.json();
            return geo.connection?.isp || geo.connection?.asn || "-";
        } catch {
            return "-";
        }
    }
}

// --- MENDAPATKAN IP ASLI ---
let REAL_IP = "0.0.0.0";
async function getRealIp(): Promise<void> {
    console.log("[*] Mendapatkan IP Asli komputermu...");
    try {
        const res = await fetch("https://speed.cloudflare.com/cdn-cgi/trace", {
            headers: { 'User-Agent': getRandomUA() },
            signal: AbortSignal.timeout(5000)
        });
        const text = await res.text();
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith("ip=")) {
                REAL_IP = line.split("=")[1].trim();
                console.log(`[+] IP Asli: ${REAL_IP}`);
                return;
            }
        }
    } catch (error) {
        console.log("[-] Gagal mendapatkan IP asli, menggunakan fallback (0.0.0.0).");
    }
}

// --- REQUEST RAW TLS ---
function sendRequest(targetIp: string, targetPort: number, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
        const options: tls.ConnectionOptions = {
            host: targetIp,
            port: targetPort,
            servername: "speed.cloudflare.com",
            rejectUnauthorized: false,
        };

        const socket = tls.connect(options, () => {
            const request = `GET /cdn-cgi/trace HTTP/1.1\r\nHost: speed.cloudflare.com\r\nUser-Agent: ${getRandomUA()}\r\nConnection: close\r\n\r\n`;
            socket.write(request);
        });

        socket.setTimeout(timeoutMs);
        
        let responseData = "";
        
        socket.on('data', (chunk) => {
            responseData += chunk.toString('utf-8');
        });
        
        socket.on('end', () => resolve(responseData));
        
        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('Timeout'));
        });
        
        socket.on('error', (err) => {
            reject(err);
        });
    });
}

// --- INTI PENGECEKAN ---
async function checkProxyOnce(proxyData: ProxyData): Promise<ActiveResult | null> {
    const { ip, port, inputIsp } = proxyData;
    const t0 = Date.now();
    
    try {
        const respStr = await sendRequest(ip, port, 5000);
        const delay = Date.now() - t0;
        
        let clientIp: string | null = null;
        let colo = "-";
        let country = "-";
        
        if (respStr.includes("colo=") && respStr.includes("ip=")) {
            const lines = respStr.split("\n").map(l => l.trim());
            for (const line of lines) {
                if (line.startsWith("ip=")) clientIp = line.split("=")[1];
                else if (line.startsWith("colo=")) colo = line.split("=")[1];
                else if (line.startsWith("loc=")) country = line.split("=")[1];
            }
            
            if (clientIp && (REAL_IP === "0.0.0.0" || clientIp !== REAL_IP)) {
                let isp = inputIsp;
                if (isp === "-") {
                    isp = await getIspGeo(clientIp);
                }
                return { ip, port, delay, country, colo, isp };
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// --- WRAPPER RETRY ---
async function checkProxyWithRetry(proxyData: ProxyData, maxRetries = 3): Promise<ActiveResult | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await checkProxyOnce(proxyData);
        if (result) return result;
        if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, 1000));
        }
    }
    return null;
}

// --- CONCURRENCY CONTROLLER ---
async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let i = 0;
    
    const workers = Array.from({ length: limit }, async () => {
        while (i < items.length) {
            const currentIndex = i++;
            const res = await fn(items[currentIndex]);
            if (res) results.push(res);
        }
    });
    
    await Promise.all(workers);
    return results;
}

// --- FUNGSI UTAMA ---
async function main() {
    console.log("=== RAW PROXY SCANNER START ===");
    
    if (!fs.existsSync(RAW_FILE)) {
        console.error(`[!] File bahan tidak ditemukan di: ${RAW_FILE}`);
        process.exit(1);
    }

    await getRealIp();

    const rawData = fs.readFileSync(RAW_FILE, 'utf-8');
    const lines = rawData.split('\n');
    
    const validProxies: ProxyData[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
        const parsed = extractIpPort(line);
        if (parsed) {
            const key = `${parsed.ip}:${parsed.port}`;
            if (!seen.has(key)) {
                seen.add(key);
                validProxies.push(parsed);
            }
        }
    }

    console.log(`[*] Ditemukan ${validProxies.length} proxy unik yang valid untuk discan.`);
    console.log(`[*] Memulai scan dengan 45 workers...`);

    let processed = 0;
    const activeProxies = await runWithConcurrency(validProxies, 45, async (proxy) => {
        const res = await checkProxyWithRetry(proxy);
        processed++;
        if (processed % 50 === 0 || processed === validProxies.length) {
            console.log(`... Progress: ${processed} / ${validProxies.length}`);
        }
        return res;
    });

    console.log(`\n=== SCAN SELESAI ===`);
    console.log(`[+] Total Active: ${activeProxies.length} dari ${validProxies.length}\n`);

    if (activeProxies.length > 0) {
        activeProxies.sort((a, b) => a.country.localeCompare(b.country));

        // 1. TIMPA ProxyList.txt (Berisi HANYA hasil scan saat ini)
        const txtOutput = activeProxies.map(p => `${p.ip},${p.port},${p.country},${p.isp}`).join('\n');
        fs.writeFileSync(LIST_FILE, txtOutput, 'utf-8');
        console.log(`[+] Tersimpan (overwrite): ${LIST_FILE}`);

        // 2. TIMPA KvProxyList.json (Berisi HANYA hasil scan saat ini)
        const kvOutput: Record<string, string[]> = {};
        for (const p of activeProxies) {
            if (!kvOutput[p.country]) {
                kvOutput[p.country] = [];
            }
            kvOutput[p.country].push(`${p.ip}:${p.port}`);
        }
        fs.writeFileSync(KV_FILE, JSON.stringify(kvOutput, null, 2), 'utf-8');
        console.log(`[+] Tersimpan (overwrite): ${KV_FILE}`);

        // 3. APPEND output.txt TANPA DUPLIKASI (Menumpuk dari waktu ke waktu)
        const existingOutput = new Set<string>();
        
        // Baca file jika sudah ada dan masukkan ke dalam Set
        if (fs.existsSync(OUTPUT_FILE)) {
            const oldData = fs.readFileSync(OUTPUT_FILE, 'utf-8').split('\n');
            for (const line of oldData) {
                const parts = line.split(',');
                if (parts.length >= 2) {
                    // Gunakan IP:PORT sebagai identitas unik
                    existingOutput.add(`${parts[0].trim()}:${parts[1].trim()}`);
                }
            }
        }

        // Cari proxy baru yang belum ada di output.txt
        const newToOutput = activeProxies.filter(p => !existingOutput.has(`${p.ip}:${p.port}`));

        if (newToOutput.length > 0) {
            const appendData = newToOutput.map(p => `${p.ip},${p.port},${p.country},${p.isp}`).join('\n') + '\n';
            fs.appendFileSync(OUTPUT_FILE, appendData, 'utf-8');
            console.log(`[+] Berhasil menambahkan (append) ${newToOutput.length} proxy baru ke: ${OUTPUT_FILE}`);
        } else {
            console.log(`[-] Tidak ada proxy baru untuk ditambahkan ke: ${OUTPUT_FILE} (Semua sudah ada)`);
        }

    } else {
        console.log("[-] Tidak ada proxy aktif, tidak ada file yang disimpan.");
    }
}

main();

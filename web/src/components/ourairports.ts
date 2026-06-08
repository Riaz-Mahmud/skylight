export async function fetchClosestAirport(lat: number, lon: number): Promise<any | null> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(
        new URL("./ourairports.worker.ts", import.meta.url),
        { type: "module" }
      );
      
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.success) {
          resolve(e.data.airport);
        } else {
          reject(new Error(e.data.error || "Worker failed to fetch airport"));
        }
      };
      
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      
      worker.postMessage({ lat, lon });
    } catch (e) {
      reject(e);
    }
  });
}

export async function fetchNearbyAirports(lat: number, lon: number, radiusMiles = 150): Promise<any[]> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(
        new URL("./ourairports.worker.ts", import.meta.url),
        { type: "module" }
      );

      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.success) {
          resolve(e.data.airports || []);
        } else {
          reject(new Error(e.data.error || "Worker failed to fetch nearby airports"));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };

      worker.postMessage({ lat, lon, mode: "nearby", radiusMiles });
    } catch (e) {
      reject(e);
    }
  });
}


import { randomInt } from 'node:crypto';

/** Windows may allocate Fetch-blocked ports for listen(0). Bind a safe high
 * port directly; the listening server retains it, with no probe/rebind race. */
export async function listenForFetch(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = randomInt(20000, 65001);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.off('error', failed); server.off('listening', ready); };
        const failed = error => { cleanup(); reject(error); };
        const ready = () => { cleanup(); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(port, host);
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  throw new Error('Could not bind a Fetch-compatible loopback test port');
}

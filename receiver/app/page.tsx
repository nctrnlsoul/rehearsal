/**
 * Deliberately says nothing about state. The ledger is behind a shared secret,
 * and a public page that reports how many payment events arrived would undo that.
 */
export default function Page() {
  return (
    <main>
      <h1>REHEARSAL receiver</h1>
      <p>Sandbox webhook receiver. Two endpoints:</p>
      <ul>
        <li>
          <code>POST /api/paypal/webhook</code> records an arrival
        </li>
        <li>
          <code>GET /api/paypal/ledger</code> returns the arrivals, bearer token required
        </li>
      </ul>
      <p>No payment data is shown here.</p>
    </main>
  );
}

import { VerifyFlow } from "./components/VerifyFlow";

export function App() {
  return (
    <>
      <header className="app-header">
        <h1>TTB Label Verification</h1>
      </header>
      <div className="container">
        <VerifyFlow />
      </div>
    </>
  );
}

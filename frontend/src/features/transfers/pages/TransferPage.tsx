import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../../shared/api/api-client';
import { BankuHeader } from '../../../shared/components/BankuHeader';
import { useAuth } from '../../auth/context/useAuth';
import { accountTransferApi, partnerBanks, type AccountTransferResult, type TransferRecipient } from '../api/account-transfer-api';
import './transfer.css';

type Step = 'recipient' | 'amount' | 'review' | 'processing' | 'complete';
type DestinationType = 'banku' | 'partner';
type PartnerBankCode = (typeof partnerBanks)[number]['code'];
type TransferSourceAccount = {
  id: string;
  label: string | null;
  currency: string;
  availableBalanceMinor: string;
  pendingCreditsMinor: string;
  lockedBalanceMinor: string;
  status: string;
  isMerchant: boolean;
  merchantName: string | null;
  merchantHandle: string | null;
  merchantStatus: string | null;
};

function toMinorUnits(value: string): string | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars = '0', cents = ''] = value.split('.');
  const amount = BigInt(dollars) * 100n + BigInt(cents.padEnd(2, '0'));
  return amount > 0n ? amount.toString() : null;
}

function formatUsd(minorUnits: string): string {
  const amount = BigInt(minorUnits);
  return `$${(amount / 100n).toLocaleString('en-US')}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the Banku API. Check your connection and try again.';
  const messages: Record<string, string> = {
    RECIPIENT_NOT_FOUND: 'No active Banku customer or merchant matches those details.',
    INSUFFICIENT_FUNDS: 'Your account does not have enough available funds.',
    ACCOUNT_NOT_ACTIVE: 'Your account is not available for transfers.',
    CURRENCY_MISMATCH: 'This transfer is not available in that currency.',
    INVALID_PARTNER_BANK: 'Choose one of the listed partner banks.',
    INVALID_BENEFICIARY: 'Enter a valid recipient name and bank account number.',
    TOO_MANY_LOOKUPS: 'Too many recipient searches. Wait a minute and try again.',
    TOO_MANY_REQUESTS: 'Too many transfer attempts. Wait a minute and try again.',
    IDEMPOTENCY_KEY_REUSED: 'This transfer request could not be safely retried. Start a new transfer.',
  };
  return messages[error.code] ?? 'The transfer could not be completed. Please try again.';
}

function isPending(status: string): boolean {
  return !['COMPLETED', 'FAILED', 'REJECTED'].includes(status);
}

function bankName(code: string | null | undefined): string {
  return partnerBanks.find((bank) => bank.code === code)?.name ?? 'Partner bank';
}

function partnerReviewDescription(result: AccountTransferResult): string {
  const review = result.partnerReconciliation;
  if (review?.reasonCode === 'CONFLICTING_TERMINAL_OUTCOMES') {
    const balanceNote = result.status === 'UNKNOWN'
      ? 'Funds remain reserved.'
      : 'Banku left the recorded account and ledger result unchanged.';
    return `The partner reported conflicting outcomes: ${review.firstStatus} and ${review.latestStatus}. ${balanceNote} Check activity for the reconciliation status.`;
  }
  if (review?.reasonCode === 'PARTNER_FAILURE_REQUIRES_REVIEW') {
    return `${formatUsd(result.amountMinor)} remains reserved. The partner reported ${review.firstStatus}; its latest report is ${review.latestStatus}. Banku is holding the funds for review.`;
  }
  if (review?.reasonCode === 'PARTNER_NOT_FOUND_AFTER_SEND') {
    return `${formatUsd(result.amountMinor)} remains reserved because the partner lookup found no payout after a possible send. Its latest report is ${review.latestStatus}. Banku will not automatically submit it again.`;
  }
  return `${formatUsd(result.amountMinor)} remains reserved while Banku reconciles the partner’s response.`;
}

export function TransferPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSourceAccountId = searchParams.get('from');
  const sourceAccounts = useMemo<TransferSourceAccount[]>(() => {
    const personal: TransferSourceAccount[] = (user?.accounts ?? []).map((account) => ({
      ...account,
      isMerchant: false,
      merchantName: null,
      merchantHandle: null,
      merchantStatus: null,
      pendingCreditsMinor: '0',
    }));
    const merchants: TransferSourceAccount[] = (user?.merchantAccounts ?? []).flatMap((merchant) =>
      merchant.account ? [{
        ...merchant.account,
        pendingCreditsMinor: merchant.account.pendingCreditsMinor ?? '0',
        isMerchant: true,
        merchantName: merchant.merchantName,
        merchantHandle: merchant.merchantHandle,
        merchantStatus: merchant.merchantStatus,
      }] : [],
    );
    return [...personal, ...merchants].filter((account) =>
      account.currency === 'USD' && account.status === 'ACTIVE' &&
      (!account.isMerchant || account.merchantStatus === 'ACTIVE'),
    );
  }, [user]);
  const [sourceAccountId, setSourceAccountId] = useState(() => requestedSourceAccountId ?? '');
  const sourceAccount = sourceAccounts.find((account) => account.id === sourceAccountId);

  useEffect(() => {
    const current = sourceAccounts.find((account) => account.id === sourceAccountId);
    const fallback = sourceAccounts[0];
    if (!current && fallback) setSourceAccountId(fallback.id);
  }, [sourceAccountId, sourceAccounts]);
  const [step, setStep] = useState<Step>('recipient');
  const [destinationType, setDestinationType] = useState<DestinationType>('banku');
  const [recipientInput, setRecipientInput] = useState('');
  const [recipient, setRecipient] = useState<TransferRecipient | null>(null);
  const [partnerBank, setPartnerBank] = useState<PartnerBankCode>('NATIONAL');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [beneficiaryAccountNumber, setBeneficiaryAccountNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<AccountTransferResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const idempotencyRequest = useRef<string | null>(null);
  const amountMinor = toMinorUnits(amount);

  useEffect(() => {
    if (step !== 'processing' || !result) return;
    let active = true;
    const checkStatus = async () => {
      try {
        const response = await accountTransferApi.status(result.id);
        if (!active) return;
        setResult(response.accountTransfer);
        if (!isPending(response.accountTransfer.status)) {
          setStep('complete');
          void refresh().catch(() => {});
        }
      } catch {
        // Keep polling through temporary API or database errors.
      }
    };
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), result.reconciliationRequired ? 10_000 : 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [step, result?.id, result?.reconciliationRequired, refresh]);

  async function findRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await accountTransferApi.lookupRecipient(recipientInput.trim());
      setRecipient(response.recipient);
      setStep('amount');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  function continueWithPartner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setStep('amount');
  }

  function reviewTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amountMinor) {
      setError('Enter an amount greater than $0.00, with no more than two decimal places.');
      return;
    }
    setError('');
    setStep('review');
  }

  async function sendTransfer() {
    if (!sourceAccount || !amountMinor || (destinationType === 'banku' && !recipient)) return;
    setBusy(true);
    setError('');
    const requestFingerprint = destinationType === 'banku'
      ? ['banku', sourceAccount.id, recipient!.accountId, amountMinor, 'USD'].join(':')
      : ['partner', sourceAccount.id, partnerBank, beneficiaryName.trim(), beneficiaryAccountNumber.trim(), amountMinor, 'USD'].join(':');
    if (idempotencyRequest.current !== requestFingerprint) {
      idempotencyRequest.current = requestFingerprint;
      idempotencyKey.current = crypto.randomUUID();
    }
    const requestKey = idempotencyKey.current!;
    try {
      const response = destinationType === 'banku'
        ? await accountTransferApi.create({
            sourceAccountId: sourceAccount.id,
            destinationAccountId: recipient!.accountId,
            amountMinor,
            currency: 'USD',
            idempotencyKey: requestKey,
          })
        : await accountTransferApi.createPartnerPayout({
            sourceAccountId: sourceAccount.id,
            partnerBank,
            beneficiaryName: beneficiaryName.trim(),
            beneficiaryAccountNumber: beneficiaryAccountNumber.trim(),
            amountMinor,
            currency: 'USD',
            idempotencyKey: requestKey,
          });
      setResult(response.accountTransfer);
      setStep(isPending(response.accountTransfer.status) ? 'processing' : 'complete');
      void refresh().catch(() => {});
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  function chooseDestination(type: DestinationType) {
    setDestinationType(type);
    setRecipient(null);
    setRecipientInput('');
    setBeneficiaryName('');
    setBeneficiaryAccountNumber('');
    setAmount('');
    setError('');
    setStep('recipient');
  }

  function startAnotherTransfer() {
    idempotencyKey.current = null;
    idempotencyRequest.current = null;
    setRecipient(null);
    setRecipientInput('');
    setBeneficiaryName('');
    setBeneficiaryAccountNumber('');
    setAmount('');
    setResult(null);
    setError('');
    setDestinationType('banku');
    setStep('recipient');
  }

  const recipientLabel = destinationType === 'banku'
    ? recipient?.fullName || recipient?.email || 'Banku account'
    : beneficiaryName.trim();
  const sourceLabel = sourceAccount?.isMerchant
    ? `${sourceAccount.merchantName} · @${sourceAccount.merchantHandle}`
    : sourceAccount?.label || 'Personal USD account';

  return (
    <main className="transfer-shell">
      <BankuHeader />

      <section className="transfer-card" aria-live="polite">
        {step !== 'complete' && step !== 'processing' && <>
          <p className="transfer-eyebrow">MOVE MONEY · USD</p>
          <div className="transfer-progress" aria-label={`Step ${step === 'recipient' ? 1 : step === 'amount' ? 2 : 3} of 3`}>
            <span className={step === 'recipient' ? 'current' : 'done'} />
            <span className={step === 'amount' ? 'current' : step === 'review' ? 'done' : ''} />
            <span className={step === 'review' ? 'current' : ''} />
          </div>
          {sourceAccounts.length > 0 && <div className="transfer-source-picker">
            <label htmlFor="source-account">Pay from</label>
            <select id="source-account" value={sourceAccount?.id ?? ''} onChange={(event) => setSourceAccountId(event.target.value)}>
              {sourceAccounts.map((account) => <option key={account.id} value={account.id}>
                {account.isMerchant ? `${account.merchantName} · @${account.merchantHandle}` : account.label || 'Personal USD account'}
              </option>)}
            </select>
            <p>Posted balance: {formatUsd(sourceAccount?.availableBalanceMinor ?? '0')}</p>
            {sourceAccount && BigInt(sourceAccount.pendingCreditsMinor) > 0n && <p className="transfer-pending-credit">Incoming credits pending: {formatUsd(sourceAccount.pendingCreditsMinor)}. Banku applies them before checking your next transfer.</p>}
          </div>}
        </>}

        {step === 'recipient' && <>
          <h1>Who are you paying?</h1>
          <div className="transfer-destination-options" role="group" aria-label="Recipient bank">
            <button type="button" aria-pressed={destinationType === 'banku'} onClick={() => chooseDestination('banku')}>Banku account</button>
            <button type="button" aria-pressed={destinationType === 'partner'} onClick={() => chooseDestination('partner')}>Another bank</button>
          </div>
          {destinationType === 'banku' ? <>
            <p className="transfer-description">Enter a customer’s email or phone number, or a merchant handle.</p>
            <form onSubmit={findRecipient} className="transfer-form">
              <label htmlFor="recipient">Email, phone, or merchant handle</label>
              <input id="recipient" autoComplete="off" value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} maxLength={254} placeholder="name@example.com, phone, or @handle" required />
              {error && <p className="transfer-error" role="alert">{error}</p>}
              <button className="transfer-primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Find recipient'} <span aria-hidden="true">→</span></button>
            </form>
          </> : <>
            <p className="transfer-description">Send USD to a recipient at one of our simulated partner banks.</p>
            <form onSubmit={continueWithPartner} className="transfer-form">
              <label htmlFor="partner-bank">Partner bank</label>
              <select id="partner-bank" value={partnerBank} onChange={(event) => setPartnerBank(event.target.value as PartnerBankCode)}>
                {partnerBanks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
              </select>
              <label htmlFor="beneficiary-name">Recipient full name</label>
              <input id="beneficiary-name" autoComplete="name" value={beneficiaryName} onChange={(event) => setBeneficiaryName(event.target.value)} maxLength={120} required />
              <label htmlFor="beneficiary-account">Recipient bank account number</label>
              <input id="beneficiary-account" autoComplete="off" inputMode="numeric" value={beneficiaryAccountNumber} onChange={(event) => setBeneficiaryAccountNumber(event.target.value)} maxLength={64} minLength={4} required />
              {error && <p className="transfer-error" role="alert">{error}</p>}
              <button className="transfer-primary" type="submit">Continue <span aria-hidden="true">→</span></button>
            </form>
          </>}
        </>}

        {step === 'amount' && <>
          <h1>How much to send?</h1>
          {destinationType === 'banku' && recipient ? <div className="recipient-card">
            <span className="recipient-avatar" aria-hidden="true">{recipient.fullName?.trim().charAt(0).toUpperCase() || '?'}</span>
            <div><strong>{recipient.fullName || 'Banku account'}</strong>{recipient.kind === 'MERCHANT'
              ? <span>Merchant · @{recipient.merchantHandle}</span>
              : <><span>{recipient.email}</span><span>{recipient.phoneNumber || 'Phone number unavailable'}</span></>}</div>
          </div> : <div className="recipient-card">
            <span className="recipient-avatar" aria-hidden="true">{beneficiaryName.trim().charAt(0).toUpperCase()}</span>
            <div><strong>{beneficiaryName.trim()}</strong><span>{bankName(partnerBank)}</span><span>Account ending {beneficiaryAccountNumber.slice(-4)}</span></div>
          </div>}
          <form onSubmit={reviewTransfer} className="transfer-form">
            <label htmlFor="amount">Amount in USD</label>
            <div className="amount-input-wrap"><span aria-hidden="true">$</span><input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} placeholder="0.00" aria-describedby="amount-hint" required /></div>
            <p id="amount-hint" className="amount-hint">Posted balance in {sourceLabel}: {formatUsd(sourceAccount?.availableBalanceMinor ?? '0')}</p>
            {sourceAccount && BigInt(sourceAccount.pendingCreditsMinor) > 0n && <p className="transfer-pending-credit">Incoming credits pending: {formatUsd(sourceAccount.pendingCreditsMinor)}. Banku applies them before checking your transfer.</p>}
            {error && <p className="transfer-error" role="alert">{error}</p>}
            <button className="transfer-primary" type="submit">Review transfer <span aria-hidden="true">→</span></button>
            <button className="transfer-secondary" type="button" onClick={() => { setError(''); setStep('recipient'); }}>Change recipient</button>
          </form>
        </>}

        {step === 'review' && amountMinor && <>
          <h1>Review your transfer.</h1>
          <p className="transfer-description">Check the details before sending.</p>
          <dl className="transfer-summary">
            <div><dt>Sending to</dt><dd>{recipientLabel}</dd></div>
            {destinationType === 'banku' && recipient ? recipient.kind === 'MERCHANT' ? <>
              <div><dt>Merchant handle</dt><dd>@{recipient.merchantHandle}</dd></div>
            </> : <>
              <div><dt>Email</dt><dd>{recipient.email || 'Not available'}</dd></div>
              <div><dt>Phone</dt><dd>{recipient.phoneNumber || 'Not available'}</dd></div>
            </> : <>
              <div><dt>Bank</dt><dd>{bankName(partnerBank)}</dd></div>
              <div><dt>Account</dt><dd>Ending {beneficiaryAccountNumber.slice(-4)}</dd></div>
            </>}
            <div><dt>From</dt><dd>{sourceLabel} · ending {sourceAccount?.id.slice(-6).toUpperCase()}</dd></div>
            <div className="summary-total"><dt>You send</dt><dd>{formatUsd(amountMinor)}</dd></div>
          </dl>
          {error && <p className="transfer-error" role="alert">{error}</p>}
          <button className="transfer-primary" type="button" onClick={sendTransfer} disabled={busy || !sourceAccount}>{busy ? 'Sending securely…' : 'Confirm and send'} <span aria-hidden="true">→</span></button>
          <button className="transfer-secondary" type="button" disabled={busy} onClick={() => { setError(''); setStep('amount'); }}>Back</button>
        </>}

        {step === 'processing' && result && <div className="transfer-complete">
          <span className="transfer-success-icon transfer-pending-icon" aria-hidden="true">…</span>
          <p className="transfer-eyebrow">PARTNER BANK PAYOUT</p>
          <h1>{result.reconciliationRequired ? 'Outcome under review.' : 'Transfer processing.'}</h1>
          <p className="transfer-description">{result.reconciliationRequired
            ? partnerReviewDescription(result)
            : `${formatUsd(result.amountMinor)} is reserved while ${bankName(result.partnerBank)} processes the payout. This page will update when the bank responds.`}</p>
          <p className="transfer-reference">Reference · {result.id}</p>
          <button className="transfer-primary" type="button" onClick={() => navigate('/dashboard')}>Back to account</button>
        </div>}

        {step === 'complete' && result && <div className="transfer-complete">
          <span className={`transfer-success-icon ${result.reconciliationRequired ? 'transfer-pending-icon' : result.status === 'COMPLETED' ? '' : 'transfer-failed-icon'}`} aria-hidden="true">{result.reconciliationRequired ? '…' : result.status === 'COMPLETED' ? '✓' : '×'}</span>
          <p className="transfer-eyebrow">{result.reconciliationRequired ? 'PARTNER OUTCOME UNDER REVIEW' : result.status === 'COMPLETED' ? 'TRANSFER COMPLETE' : 'TRANSFER FAILED'}</p>
          <h1>{result.reconciliationRequired ? 'Outcome under review.' : result.status === 'COMPLETED' ? 'Money sent.' : 'Transfer failed.'}</h1>
          <p className="transfer-description">{result.reconciliationRequired
            ? partnerReviewDescription(result)
            : result.status === 'COMPLETED'
              ? `${formatUsd(result.amountMinor)} sent to ${destinationType === 'banku' ? recipientLabel : `${recipientLabel} at ${bankName(result.partnerBank)}`}.`
              : `The partner bank declined the payout. Reserved funds have been returned to your available balance.`}</p>
          <p className="transfer-reference">Reference · {result.providerReference || result.id}</p>
          <button className="transfer-primary" type="button" onClick={() => navigate('/dashboard')}>Back to account</button>
          <button className="transfer-secondary" type="button" onClick={startAnotherTransfer}>Make another transfer</button>
        </div>}
      </section>
    </main>
  );
}

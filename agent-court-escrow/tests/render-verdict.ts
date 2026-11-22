import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import { AgentCourtEscrow } from "../target/types/agent_court_escrow";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

describe("render_verdict judge authorization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.agentCourtEscrow as Program<AgentCourtEscrow>;
  const connection = provider.connection;

  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const judge = Keypair.generate();
  const mint = Keypair.generate();
  const amount = new anchor.BN(1_000_000);
  const timeout = new anchor.BN(3_600);

  const ata = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
  const createAtaIx = (owner: PublicKey) =>
    new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: agentA.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata(owner), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    });
  const escrowFor = (serviceHash: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), agentA.publicKey.toBuffer(), agentB.publicKey.toBuffer(), serviceHash],
      program.programId
    )[0];
  const vaultFor = (escrow: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId)[0];
  const tokenBalance = async (account: PublicKey) =>
    Number((await connection.getTokenAccountBalance(account)).value.amount);

  const deposit = (serviceHash: Buffer, judgeKey: PublicKey) => {
    const escrow = escrowFor(serviceHash);
    return program.methods
      .deposit(amount, Array.from(serviceHash), timeout)
      .accountsStrict({
        agentA: agentA.publicKey,
        agentB: agentB.publicKey,
        mint: mint.publicKey,
        escrow,
        vault: vaultFor(escrow),
        agentATokenAccount: ata(agentA.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        judge: judgeKey,
      })
      .signers([agentA])
      .rpc();
  };
  const renderVerdict = (escrow: PublicKey, signer: Keypair) =>
    program.methods
      .renderVerdict({ refund: {} }, 0, 0)
      .accountsStrict({ judge: signer.publicKey, escrow })
      .signers([signer])
      .rpc();

  before(async () => {
    for (const kp of [agentA, agentB, judge]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    }
    // 6-decimal mint, agent A as mint authority, then fund agent A's ATA.
    const initMint = Buffer.alloc(67);
    initMint[0] = 20; // InitializeMint2
    initMint[1] = 6;
    agentA.publicKey.toBuffer().copy(initMint, 2);
    const mintTo = Buffer.alloc(9);
    mintTo[0] = 7; // MintTo
    mintTo.writeBigUInt64LE(10_000_000n, 1);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: agentA.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        space: 82,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
        data: initMint,
      }),
      createAtaIx(agentA.publicKey),
      createAtaIx(agentB.publicKey),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ata(agentA.publicKey), isSigner: false, isWritable: true },
          { pubkey: agentA.publicKey, isSigner: true, isWritable: false },
        ],
        data: mintTo,
      })
    );
    await provider.sendAndConfirm(tx, [agentA, mint]);
  });

  it("rejects a deposit that names agent A or agent B as the judge", async () => {
    for (const judgeKey of [agentA.publicKey, agentB.publicKey]) {
      let error: any = null;
      try {
        await deposit(createHash("sha256").update(`self-judge-${judgeKey}`).digest(), judgeKey);
      } catch (e) {
        error = e;
      }
      expect(error, "deposit with a party as judge should fail").to.not.be.null;
      expect(String(error)).to.include("InvalidJudge");
    }
  });

  it("only the recorded judge can render a verdict", async () => {
    const serviceHash = createHash("sha256").update("disputed service").digest();
    const escrow = escrowFor(serviceHash);
    await deposit(serviceHash, judge.publicKey);
    await program.methods
      .fileDispute()
      .accountsStrict({ signer: agentA.publicKey, escrow })
      .signers([agentA])
      .rpc();

    // Agent A (the payer) tries to rule in its own favour.
    let error: any = null;
    try {
      await renderVerdict(escrow, agentA);
    } catch (e) {
      error = e;
    }
    expect(error, "agent A should not be able to render a verdict").to.not.be.null;
    expect(String(error)).to.include("Unauthorized");
    expect((await program.account.escrow.fetch(escrow)).status).to.deep.equal({ disputed: {} });

    // The judge named at deposit can.
    await renderVerdict(escrow, judge);
    const resolved = await program.account.escrow.fetch(escrow);
    expect(resolved.status).to.deep.equal({ resolved: {} });
    expect(resolved.verdict).to.deep.equal({ refund: {} });

    const before = await tokenBalance(ata(agentA.publicKey));
    await program.methods
      .claim()
      .accountsStrict({
        claimer: agentA.publicKey,
        escrow,
        vault: vaultFor(escrow),
        mint: mint.publicKey,
        agentATokenAccount: ata(agentA.publicKey),
        agentBTokenAccount: ata(agentB.publicKey),
        agentA: agentA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentA])
      .rpc();
    expect((await tokenBalance(ata(agentA.publicKey))) - before).to.equal(amount.toNumber());
  });
});

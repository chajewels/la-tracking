-- Restore 13 forfeited accounts back to overdue (from old auto-forfeit rule)
UPDATE layaway_accounts SET status = 'overdue', updated_at = now()
WHERE id IN (
  'd71e871f-7d6b-4667-92a5-198735dda306', 'b2428b74-6eea-415e-b5ed-aaac7df1daec',
  'd539f2ed-d1b4-4a83-85ed-61f319f47846', '7d0eba0e-f6f6-4c23-8139-9f71f394fe55',
  '3458d566-4516-4c33-9e32-55e681422fae', 'dd2d32e6-3652-4e1f-ab50-ba46be05f98e',
  '2833bbc1-d8b4-482b-b681-e7b639e194ff', '3aa5d220-8da0-4259-9f52-7a12c670b120',
  'a695b262-baad-4d38-ae50-8465942a0746', '792e5857-6c4a-4bfc-ac7d-acd1292bd621',
  'b6ccf1f5-1031-42bb-9517-4a19b46dc7af', '9cc0f3b2-6e47-44b2-9e1a-0f52b7084ae1',
  '107ebf5a-5b13-4c39-a787-911b0d703bb6'
);

-- Restore 3 final_settlement accounts back to overdue
UPDATE layaway_accounts SET status = 'overdue', updated_at = now()
WHERE id IN (
  '0e7a5893-635e-4109-bdc0-e3304cc9dee7',
  '7bcfa587-6f3f-4603-b8e8-c33cb9c21a41',
  '66b61dd6-d2c7-49a7-9374-b1e3e3ba23c0'
);

-- Un-cancel schedule items that were cancelled by auto-forfeit
UPDATE layaway_schedule SET status = 'overdue', updated_at = now()
WHERE account_id IN (
  'd71e871f-7d6b-4667-92a5-198735dda306', 'b2428b74-6eea-415e-b5ed-aaac7df1daec',
  'd539f2ed-d1b4-4a83-85ed-61f319f47846', '7d0eba0e-f6f6-4c23-8139-9f71f394fe55',
  '3458d566-4516-4c33-9e32-55e681422fae', 'dd2d32e6-3652-4e1f-ab50-ba46be05f98e',
  '2833bbc1-d8b4-482b-b681-e7b639e194ff', '3aa5d220-8da0-4259-9f52-7a12c670b120',
  'a695b262-baad-4d38-ae50-8465942a0746', '792e5857-6c4a-4bfc-ac7d-acd1292bd621',
  'b6ccf1f5-1031-42bb-9517-4a19b46dc7af', '9cc0f3b2-6e47-44b2-9e1a-0f52b7084ae1',
  '107ebf5a-5b13-4c39-a787-911b0d703bb6'
) AND status = 'cancelled';

-- Delete the 3 incorrectly created final settlement records (created under old 5th-penalty rule)
DELETE FROM final_settlement_records WHERE id IN (
  '5d5c97c1-cd67-4d5b-a87b-59912a80c412',
  '1b54ef52-2464-44f1-ac8c-b4a5a96424ba',
  '60028f4d-3f33-4a64-8232-55abe9c9bdb0'
);
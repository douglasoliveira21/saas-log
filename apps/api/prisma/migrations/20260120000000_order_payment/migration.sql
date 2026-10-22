-- Forma de pagamento da venda (boleto: parcelas e 1o vencimento).
ALTER TABLE sales_orders ADD COLUMN payment_method text, ADD COLUMN installment_count integer NOT NULL DEFAULT 1, ADD COLUMN first_due_date date, ADD COLUMN installment_interval_days integer NOT NULL DEFAULT 30;

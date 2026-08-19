export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      account_notes: {
        Row: {
          account_id: string | null
          cash_order_id: string | null
          created_at: string
          created_by_name: string | null
          created_by_user_id: string | null
          id: string
          note_text: string
        }
        Insert: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_name?: string | null
          created_by_user_id?: string | null
          id?: string
          note_text: string
        }
        Update: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_name?: string | null
          created_by_user_id?: string | null
          id?: string
          note_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_notes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_notes_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      account_services: {
        Row: {
          account_id: string
          amount: number
          created_at: string
          created_by_user_id: string | null
          currency: string
          description: string | null
          id: string
          service_type: string
          updated_at: string
        }
        Insert: {
          account_id: string
          amount?: number
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          description?: string | null
          id?: string
          service_type: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          amount?: number
          created_at?: string
          created_by_user_id?: string | null
          currency?: string
          description?: string | null
          id?: string
          service_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_services_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          content: string
          created_at: string | null
          created_by: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          link_label: string | null
          link_url: string | null
          show_once: boolean | null
          title: string
          updated_at: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link_label?: string | null
          link_url?: string | null
          show_once?: boolean | null
          title: string
          updated_at?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link_label?: string | null
          link_url?: string | null
          show_once?: boolean | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          new_value_json: Json | null
          old_value_json: Json | null
          performed_by_user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          new_value_json?: Json | null
          old_value_json?: Json | null
          performed_by_user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          new_value_json?: Json | null
          old_value_json?: Json | null
          performed_by_user_id?: string | null
        }
        Relationships: []
      }
      cash_order_items: {
        Row: {
          cash_order_id: string
          created_at: string
          id: string
          image_url: string | null
          line_total_jpy: number
          product_id: string | null
          quantity: number
          shopify_line_item_id: string | null
          sku: string | null
          title: string
          unit_price_jpy: number
        }
        Insert: {
          cash_order_id: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total_jpy: number
          product_id?: string | null
          quantity?: number
          shopify_line_item_id?: string | null
          sku?: string | null
          title: string
          unit_price_jpy: number
        }
        Update: {
          cash_order_id?: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total_jpy?: number
          product_id?: string | null
          quantity?: number
          shopify_line_item_id?: string | null
          sku?: string | null
          title?: string
          unit_price_jpy?: number
        }
        Relationships: [
          {
            foreignKeyName: "cash_order_items_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_orders: {
        Row: {
          accepted_by_user_id: string | null
          agreement_acceptance_datetime: string | null
          agreement_version: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by_user_id: string | null
          cash_receipt_sheet_id: string | null
          completed_at: string | null
          created_at: string
          created_by_user_id: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          discount_amount: number
          discount_type: string | null
          discount_value: number | null
          expired_at: string | null
          expires_at: string | null
          id: string
          invoice_number: string
          is_test: boolean
          is_trade: boolean
          item_description: string | null
          loyalty_jpy_amount: number | null
          notes: string | null
          order_date: string
          pancake_order_id: string | null
          remaining_balance: number
          shipping_fee: number
          shopify_order_id: string | null
          source_channel: string
          status: Database["public"]["Enums"]["cash_order_status"]
          total_amount: number
          total_paid: number
          updated_at: string
        }
        Insert: {
          accepted_by_user_id?: string | null
          agreement_acceptance_datetime?: string | null
          agreement_version?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          cash_receipt_sheet_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          expired_at?: string | null
          expires_at?: string | null
          id?: string
          invoice_number: string
          is_test?: boolean
          is_trade?: boolean
          item_description?: string | null
          loyalty_jpy_amount?: number | null
          notes?: string | null
          order_date?: string
          pancake_order_id?: string | null
          remaining_balance: number
          shipping_fee?: number
          shopify_order_id?: string | null
          source_channel?: string
          status?: Database["public"]["Enums"]["cash_order_status"]
          total_amount: number
          total_paid?: number
          updated_at?: string
        }
        Update: {
          accepted_by_user_id?: string | null
          agreement_acceptance_datetime?: string | null
          agreement_version?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          cash_receipt_sheet_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          expired_at?: string | null
          expires_at?: string | null
          id?: string
          invoice_number?: string
          is_test?: boolean
          is_trade?: boolean
          item_description?: string | null
          loyalty_jpy_amount?: number | null
          notes?: string | null
          order_date?: string
          pancake_order_id?: string | null
          remaining_balance?: number
          shipping_fee?: number
          shopify_order_id?: string | null
          source_channel?: string
          status?: Database["public"]["Enums"]["cash_order_status"]
          total_amount?: number
          total_paid?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_payments: {
        Row: {
          amount_paid: number
          cash_order_id: string
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          date_paid: string
          entered_by_user_id: string | null
          id: string
          payment_method: string | null
          reference_number: string | null
          remarks: string | null
          submitted_by_name: string | null
          submitted_by_type: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by_user_id: string | null
        }
        Insert: {
          amount_paid: number
          cash_order_id: string
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          date_paid: string
          entered_by_user_id?: string | null
          id?: string
          payment_method?: string | null
          reference_number?: string | null
          remarks?: string | null
          submitted_by_name?: string | null
          submitted_by_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_user_id?: string | null
        }
        Update: {
          amount_paid?: number
          cash_order_id?: string
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          date_paid?: string
          entered_by_user_id?: string | null
          id?: string
          payment_method?: string | null
          reference_number?: string | null
          remarks?: string | null
          submitted_by_name?: string | null
          submitted_by_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_payments_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_agents: {
        Row: {
          active: boolean
          color: string
          created_at: string
          id: string
          name: string
          sort_order: number
          start_month: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          color?: string
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          start_month?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          color?: string
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          start_month?: string
          user_id?: string | null
        }
        Relationships: []
      }
      commission_splits: {
        Row: {
          closer_pct: number
          coordinator_pct: number
          merge_groups: Json
          month: string
          pool_per_item_php: number
          processor_pct: number
          support_pct: number
          top_sales_2_pct: number
          top_sales_pct: number
          updated_at: string
          verifier_pct: number
        }
        Insert: {
          closer_pct?: number
          coordinator_pct?: number
          merge_groups?: Json
          month: string
          pool_per_item_php?: number
          processor_pct?: number
          support_pct?: number
          top_sales_2_pct?: number
          top_sales_pct?: number
          updated_at?: string
          verifier_pct?: number
        }
        Update: {
          closer_pct?: number
          coordinator_pct?: number
          merge_groups?: Json
          month?: string
          pool_per_item_php?: number
          processor_pct?: number
          support_pct?: number
          top_sales_2_pct?: number
          top_sales_pct?: number
          updated_at?: string
          verifier_pct?: number
        }
        Relationships: []
      }
      csr_notifications: {
        Row: {
          account_id: string
          contact_method: string | null
          created_at: string
          customer_id: string
          due_date: string
          id: string
          invoice_number: string
          notified: boolean
          notified_at: string
          notified_by_name: string
          notified_by_user_id: string
          remarks: string | null
          reminder_stage: string
          schedule_id: string
        }
        Insert: {
          account_id: string
          contact_method?: string | null
          created_at?: string
          customer_id: string
          due_date: string
          id?: string
          invoice_number: string
          notified?: boolean
          notified_at?: string
          notified_by_name: string
          notified_by_user_id: string
          remarks?: string | null
          reminder_stage: string
          schedule_id: string
        }
        Update: {
          account_id?: string
          contact_method?: string | null
          created_at?: string
          customer_id?: string
          due_date?: string
          id?: string
          invoice_number?: string
          notified?: boolean
          notified_at?: string
          notified_by_name?: string
          notified_by_user_id?: string
          remarks?: string | null
          reminder_stage?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "csr_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csr_notifications_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csr_notifications_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csr_notifications_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_analytics: {
        Row: {
          completion_probability_score: number | null
          customer_id: string
          id: string
          last_calculated_at: string | null
          late_payment_risk_level:
            | Database["public"]["Enums"]["risk_level"]
            | null
          late_payment_risk_score: number | null
          lifetime_value_amount: number | null
          lifetime_value_tier: Database["public"]["Enums"]["clv_tier"] | null
          payment_reliability_score: number | null
        }
        Insert: {
          completion_probability_score?: number | null
          customer_id: string
          id?: string
          last_calculated_at?: string | null
          late_payment_risk_level?:
            | Database["public"]["Enums"]["risk_level"]
            | null
          late_payment_risk_score?: number | null
          lifetime_value_amount?: number | null
          lifetime_value_tier?: Database["public"]["Enums"]["clv_tier"] | null
          payment_reliability_score?: number | null
        }
        Update: {
          completion_probability_score?: number | null
          customer_id?: string
          id?: string
          last_calculated_at?: string | null
          late_payment_risk_level?:
            | Database["public"]["Enums"]["risk_level"]
            | null
          late_payment_risk_score?: number | null
          lifetime_value_amount?: number | null
          lifetime_value_tier?: Database["public"]["Enums"]["clv_tier"] | null
          payment_reliability_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_analytics_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_pins: {
        Row: {
          customer_id: string
          pin_attempts: number
          pin_hash: string | null
          pin_locked_until: string | null
        }
        Insert: {
          customer_id: string
          pin_attempts?: number
          pin_hash?: string | null
          pin_locked_until?: string | null
        }
        Update: {
          customer_id?: string
          pin_attempts?: number
          pin_hash?: string | null
          pin_locked_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_pins_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_sessions: {
        Row: {
          created_at: string
          customer_id: string
          expires_at: string
          ip_address: unknown
          last_used_at: string
          session_id: string
          source_token_id: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          expires_at?: string
          ip_address?: unknown
          last_used_at?: string
          session_id?: string
          source_token_id: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          expires_at?: string
          ip_address?: unknown
          last_used_at?: string
          session_id?: string
          source_token_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_portal_sessions_source_token_id_fkey"
            columns: ["source_token_id"]
            isOneToOne: false
            referencedRelation: "customer_portal_tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_tokens: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          customer_id: string
          expires_at: string | null
          id: string
          is_active: boolean
          token: string
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          customer_id: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          token?: string
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          customer_id?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_tokens_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address_line1: string | null
          auth_user_id: string | null
          birthday: string | null
          birthday_admin_edits_used: number | null
          birthday_locked_at: string | null
          city: string | null
          country: string | null
          created_at: string
          customer_code: string | null
          email: string | null
          facebook_name: string | null
          full_name: string
          id: string
          is_test: boolean
          last_birthday_award_year: number | null
          location: string | null
          messenger_link: string | null
          mobile_number: string | null
          needs_review: boolean
          notes: string | null
          pancake_fb_id: string | null
          postal_code: string | null
          preferred_contact_method: string | null
          setup_link_sent_at: string | null
          shopify_customer_id: string | null
          source: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          auth_user_id?: string | null
          birthday?: string | null
          birthday_admin_edits_used?: number | null
          birthday_locked_at?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          customer_code?: string | null
          email?: string | null
          facebook_name?: string | null
          full_name: string
          id?: string
          is_test?: boolean
          last_birthday_award_year?: number | null
          location?: string | null
          messenger_link?: string | null
          mobile_number?: string | null
          needs_review?: boolean
          notes?: string | null
          pancake_fb_id?: string | null
          postal_code?: string | null
          preferred_contact_method?: string | null
          setup_link_sent_at?: string | null
          shopify_customer_id?: string | null
          source?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          auth_user_id?: string | null
          birthday?: string | null
          birthday_admin_edits_used?: number | null
          birthday_locked_at?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          customer_code?: string | null
          email?: string | null
          facebook_name?: string | null
          full_name?: string
          id?: string
          is_test?: boolean
          last_birthday_award_year?: number | null
          location?: string | null
          messenger_link?: string | null
          mobile_number?: string | null
          needs_review?: boolean
          notes?: string | null
          pancake_fb_id?: string | null
          postal_code?: string | null
          preferred_contact_method?: string | null
          setup_link_sent_at?: string | null
          shopify_customer_id?: string | null
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          idempotency_key: string | null
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      extension_requests: {
        Row: {
          account_id: string | null
          customer_id: string | null
          extension_expiry_date: string | null
          id: string
          portal_token: string | null
          reason: string | null
          requested_at: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_notes: string | null
          status: string | null
        }
        Insert: {
          account_id?: string | null
          customer_id?: string | null
          extension_expiry_date?: string | null
          id?: string
          portal_token?: string | null
          reason?: string | null
          requested_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_notes?: string | null
          status?: string | null
        }
        Update: {
          account_id?: string | null
          customer_id?: string | null
          extension_expiry_date?: string | null
          id?: string
          portal_token?: string | null
          reason?: string | null
          requested_at?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_notes?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_toggles: {
        Row: {
          description: string | null
          feature_key: string
          id: string
          is_enabled: boolean
          label: string
          module: string
          sort_order: number
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          description?: string | null
          feature_key: string
          id?: string
          is_enabled?: boolean
          label: string
          module: string
          sort_order?: number
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: {
          description?: string | null
          feature_key?: string
          id?: string
          is_enabled?: boolean
          label?: string
          module?: string
          sort_order?: number
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Relationships: []
      }
      final_settlement_records: {
        Row: {
          account_id: string
          calculation_json: Json | null
          created_at: string
          final_settlement_amount: number
          id: string
          last_paid_month_date: string | null
          penalty_occurrence_count: number
          penalty_total_from_last_paid: number
          remaining_principal: number
        }
        Insert: {
          account_id: string
          calculation_json?: Json | null
          created_at?: string
          final_settlement_amount?: number
          id?: string
          last_paid_month_date?: string | null
          penalty_occurrence_count?: number
          penalty_total_from_last_paid?: number
          remaining_principal?: number
        }
        Update: {
          account_id?: string
          calculation_json?: Json | null
          created_at?: string
          final_settlement_amount?: number
          id?: string
          last_paid_month_date?: string | null
          penalty_occurrence_count?: number
          penalty_total_from_last_paid?: number
          remaining_principal?: number
        }
        Relationships: [
          {
            foreignKeyName: "final_settlement_records_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_alerts: {
        Row: {
          alert_type: string
          created_at: string | null
          current_value: number | null
          id: string
          message: string
          plan_months: number | null
          resolved_at: string | null
          severity: string
          threshold_value: number | null
        }
        Insert: {
          alert_type: string
          created_at?: string | null
          current_value?: number | null
          id?: string
          message: string
          plan_months?: number | null
          resolved_at?: string | null
          severity: string
          threshold_value?: number | null
        }
        Update: {
          alert_type?: string
          created_at?: string | null
          current_value?: number | null
          id?: string
          message?: string
          plan_months?: number | null
          resolved_at?: string | null
          severity?: string
          threshold_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "financial_alerts_plan_months_fkey"
            columns: ["plan_months"]
            isOneToOne: false
            referencedRelation: "plan_configurations"
            referencedColumns: ["plan_months"]
          },
        ]
      }
      forecast_snapshots: {
        Row: {
          created_at: string
          currency_mode: string
          forecast_period_end: string
          forecast_period_start: string
          forecast_type: string
          forecast_value: number
          id: string
          metadata_json: Json | null
        }
        Insert: {
          created_at?: string
          currency_mode?: string
          forecast_period_end: string
          forecast_period_start: string
          forecast_type: string
          forecast_value: number
          id?: string
          metadata_json?: Json | null
        }
        Update: {
          created_at?: string
          currency_mode?: string
          forecast_period_end?: string
          forecast_period_start?: string
          forecast_type?: string
          forecast_value?: number
          id?: string
          metadata_json?: Json | null
        }
        Relationships: []
      }
      generated_invoices: {
        Row: {
          account_id: string | null
          bill_to: Json
          cash_order_id: string | null
          discount_jpy: number
          drive_folder_path: string
          generated_at: string
          generated_by_name: string | null
          generated_by_user_id: string | null
          id: string
          items: Json
          parent_invoice_number: string
          sheet_id: string
          sheet_url: string
          ship_to: Json
          shipping_fee_jpy: number
          subtotal_pretax_jpy: number
          tax_jpy: number
          total_jpy: number
        }
        Insert: {
          account_id?: string | null
          bill_to: Json
          cash_order_id?: string | null
          discount_jpy?: number
          drive_folder_path: string
          generated_at?: string
          generated_by_name?: string | null
          generated_by_user_id?: string | null
          id?: string
          items: Json
          parent_invoice_number: string
          sheet_id: string
          sheet_url: string
          ship_to: Json
          shipping_fee_jpy?: number
          subtotal_pretax_jpy: number
          tax_jpy: number
          total_jpy: number
        }
        Update: {
          account_id?: string | null
          bill_to?: Json
          cash_order_id?: string | null
          discount_jpy?: number
          drive_folder_path?: string
          generated_at?: string
          generated_by_name?: string | null
          generated_by_user_id?: string | null
          id?: string
          items?: Json
          parent_invoice_number?: string
          sheet_id?: string
          sheet_url?: string
          ship_to?: Json
          shipping_fee_jpy?: number
          subtotal_pretax_jpy?: number
          tax_jpy?: number
          total_jpy?: number
        }
        Relationships: [
          {
            foreignKeyName: "generated_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_invoices_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      inquiry_dropdown_options: {
        Row: {
          created_at: string
          dropdown_type: string
          id: string
          sort_order: number
          value: string
        }
        Insert: {
          created_at?: string
          dropdown_type: string
          id?: string
          sort_order?: number
          value: string
        }
        Update: {
          created_at?: string
          dropdown_type?: string
          id?: string
          sort_order?: number
          value?: string
        }
        Relationships: []
      }
      keep_fix_audit: {
        Row: {
          base_installment_amount: number | null
          carried_amount: number | null
          currency: Database["public"]["Enums"]["account_currency"] | null
          installment_number: number | null
          invoice_number: string | null
          paid_amount: number | null
          penalty_amount: number | null
          remaining_balance: number | null
          schedule_id: string | null
          snapshot_at: string | null
          status: Database["public"]["Enums"]["schedule_status"] | null
          total_due_amount: number | null
        }
        Insert: {
          base_installment_amount?: number | null
          carried_amount?: number | null
          currency?: Database["public"]["Enums"]["account_currency"] | null
          installment_number?: number | null
          invoice_number?: string | null
          paid_amount?: number | null
          penalty_amount?: number | null
          remaining_balance?: number | null
          schedule_id?: string | null
          snapshot_at?: string | null
          status?: Database["public"]["Enums"]["schedule_status"] | null
          total_due_amount?: number | null
        }
        Update: {
          base_installment_amount?: number | null
          carried_amount?: number | null
          currency?: Database["public"]["Enums"]["account_currency"] | null
          installment_number?: number | null
          invoice_number?: string | null
          paid_amount?: number | null
          penalty_amount?: number | null
          remaining_balance?: number | null
          schedule_id?: string | null
          snapshot_at?: string | null
          status?: Database["public"]["Enums"]["schedule_status"] | null
          total_due_amount?: number | null
        }
        Relationships: []
      }
      layaway_account_items: {
        Row: {
          account_id: string
          created_at: string
          id: string
          image_url: string | null
          line_total_jpy: number
          product_id: string | null
          quantity: number
          shopify_line_item_id: string | null
          sku: string | null
          title: string
          unit_price_jpy: number
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total_jpy: number
          product_id?: string | null
          quantity?: number
          shopify_line_item_id?: string | null
          sku?: string | null
          title: string
          unit_price_jpy: number
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total_jpy?: number
          product_id?: string | null
          quantity?: number
          shopify_line_item_id?: string | null
          sku?: string | null
          title?: string
          unit_price_jpy?: number
        }
        Relationships: [
          {
            foreignKeyName: "layaway_account_items_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_account_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      layaway_accounts: {
        Row: {
          accepted_by_user_id: string | null
          agreement_acceptance_date: string | null
          agreement_version: string | null
          cash_receipt_sheet_id: string | null
          completed_at: string | null
          created_at: string
          created_by_user_id: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          discount_amount: number
          discount_type: string | null
          discount_value: number | null
          downpayment_amount: number
          end_date: string | null
          extension_end_date: string | null
          forfeited_at: string | null
          id: string
          invoice_number: string
          is_reactivated: boolean
          is_test: boolean
          is_trade: boolean
          loyalty_jpy_amount: number | null
          notes: string | null
          order_date: string
          pancake_order_id: string | null
          payment_plan_months: number
          penalty_count_at_reactivation: number | null
          reactivated_at: string | null
          reactivated_by_user_id: string | null
          remaining_balance: number
          shipping_fee: number
          status: Database["public"]["Enums"]["account_status"]
          total_amount: number
          total_paid: number
          updated_at: string
        }
        Insert: {
          accepted_by_user_id?: string | null
          agreement_acceptance_date?: string | null
          agreement_version?: string | null
          cash_receipt_sheet_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          downpayment_amount?: number
          end_date?: string | null
          extension_end_date?: string | null
          forfeited_at?: string | null
          id?: string
          invoice_number: string
          is_reactivated?: boolean
          is_test?: boolean
          is_trade?: boolean
          loyalty_jpy_amount?: number | null
          notes?: string | null
          order_date: string
          pancake_order_id?: string | null
          payment_plan_months: number
          penalty_count_at_reactivation?: number | null
          reactivated_at?: string | null
          reactivated_by_user_id?: string | null
          remaining_balance: number
          shipping_fee?: number
          status?: Database["public"]["Enums"]["account_status"]
          total_amount: number
          total_paid?: number
          updated_at?: string
        }
        Update: {
          accepted_by_user_id?: string | null
          agreement_acceptance_date?: string | null
          agreement_version?: string | null
          cash_receipt_sheet_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          discount_amount?: number
          discount_type?: string | null
          discount_value?: number | null
          downpayment_amount?: number
          end_date?: string | null
          extension_end_date?: string | null
          forfeited_at?: string | null
          id?: string
          invoice_number?: string
          is_reactivated?: boolean
          is_test?: boolean
          is_trade?: boolean
          loyalty_jpy_amount?: number | null
          notes?: string | null
          order_date?: string
          pancake_order_id?: string | null
          payment_plan_months?: number
          penalty_count_at_reactivation?: number | null
          reactivated_at?: string | null
          reactivated_by_user_id?: string | null
          remaining_balance?: number
          shipping_fee?: number
          status?: Database["public"]["Enums"]["account_status"]
          total_amount?: number
          total_paid?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "layaway_accounts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      layaway_schedule: {
        Row: {
          account_id: string
          base_installment_amount: number
          carried_amount: number | null
          carried_by_payment_id: string | null
          carried_from_schedule_id: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          due_date: string
          generated_at: string
          id: string
          installment_number: number
          paid_amount: number
          penalty_amount: number
          status: Database["public"]["Enums"]["schedule_status"]
          total_due_amount: number
          updated_at: string
        }
        Insert: {
          account_id: string
          base_installment_amount: number
          carried_amount?: number | null
          carried_by_payment_id?: string | null
          carried_from_schedule_id?: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          due_date: string
          generated_at?: string
          id?: string
          installment_number: number
          paid_amount?: number
          penalty_amount?: number
          status?: Database["public"]["Enums"]["schedule_status"]
          total_due_amount: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          base_installment_amount?: number
          carried_amount?: number | null
          carried_by_payment_id?: string | null
          carried_from_schedule_id?: string | null
          currency?: Database["public"]["Enums"]["account_currency"]
          due_date?: string
          generated_at?: string
          id?: string
          installment_number?: number
          paid_amount?: number
          penalty_amount?: number
          status?: Database["public"]["Enums"]["schedule_status"]
          total_due_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "layaway_schedule_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_by_payment_id_fkey"
            columns: ["carried_by_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_from_schedule_id_fkey"
            columns: ["carried_from_schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_from_schedule_id_fkey"
            columns: ["carried_from_schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_award_19015_audit_20260520: {
        Row: {
          cumulative_spend_jpy: number | null
          current_tier_id: string | null
          customer_id: string | null
          earned_tier_id: string | null
          enrolled_at: string | null
          id: string | null
          is_downgraded: boolean | null
          last_purchase_at: string | null
          pre_expiry_warned_at: string | null
          prev_purchase_at: string | null
          remaining_points: number | null
          total_points_earned: number | null
          total_points_expired: number | null
          total_points_redeemed: number | null
          updated_at: string | null
        }
        Insert: {
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Update: {
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      loyalty_banners: {
        Row: {
          applicable_tiers: string[] | null
          banner_type: string
          created_at: string
          created_by_user_id: string | null
          description: string | null
          display_priority: number
          emoji: string | null
          end_at: string | null
          id: string
          image_url: string | null
          is_active: boolean
          link_target: string | null
          start_at: string | null
          subtitle: string | null
          title: string
          updated_at: string
        }
        Insert: {
          applicable_tiers?: string[] | null
          banner_type: string
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          display_priority?: number
          emoji?: string | null
          end_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          link_target?: string | null
          start_at?: string | null
          subtitle?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          applicable_tiers?: string[] | null
          banner_type?: string
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          display_priority?: number
          emoji?: string | null
          end_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          link_target?: string | null
          start_at?: string | null
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      loyalty_beta_members: {
        Row: {
          added_by_user_id: string | null
          created_at: string
          customer_id: string
          id: string
          notes: string | null
        }
        Insert: {
          added_by_user_id?: string | null
          created_at?: string
          customer_id: string
          id?: string
          notes?: string | null
        }
        Update: {
          added_by_user_id?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_beta_members_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_expiry_restore_audit_20260520: {
        Row: {
          captured_at: string | null
          cumulative_spend_jpy: number | null
          current_tier_id: string | null
          customer_id: string | null
          earned_tier_id: string | null
          enrolled_at: string | null
          id: string | null
          is_downgraded: boolean | null
          last_purchase_at: string | null
          pre_expiry_warned_at: string | null
          prev_purchase_at: string | null
          remaining_points: number | null
          total_points_earned: number | null
          total_points_expired: number | null
          total_points_redeemed: number | null
          updated_at: string | null
        }
        Insert: {
          captured_at?: string | null
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Update: {
          captured_at?: string | null
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      loyalty_last_purchase_backfill_audit_20260520: {
        Row: {
          customer_id: string | null
          last_purchase_at: string | null
          member_id: string | null
          updated_at: string | null
        }
        Insert: {
          customer_id?: string | null
          last_purchase_at?: string | null
          member_id?: string | null
          updated_at?: string | null
        }
        Update: {
          customer_id?: string | null
          last_purchase_at?: string | null
          member_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      loyalty_lot_consumption: {
        Row: {
          amount: number
          consumed_at: string
          id: string
          lot_id: string
          redemption_id: string
          restored_amount: number | null
          restored_at: string | null
        }
        Insert: {
          amount: number
          consumed_at?: string
          id?: string
          lot_id: string
          redemption_id: string
          restored_amount?: number | null
          restored_at?: string | null
        }
        Update: {
          amount?: number
          consumed_at?: string
          id?: string
          lot_id?: string
          redemption_id?: string
          restored_amount?: number | null
          restored_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_lot_consumption_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "loyalty_point_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_lot_consumption_redemption_id_fkey"
            columns: ["redemption_id"]
            isOneToOne: false
            referencedRelation: "loyalty_redemptions"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_members: {
        Row: {
          cumulative_spend_jpy: number
          current_tier_id: string
          customer_id: string
          downgrade_spend_baseline: number | null
          earned_tier_id: string
          enrolled_at: string
          id: string
          is_downgraded: boolean
          last_purchase_at: string | null
          pre_expiry_warned_at: string | null
          prev_purchase_at: string | null
          remaining_points: number
          total_points_earned: number
          total_points_expired: number
          total_points_redeemed: number
          updated_at: string
        }
        Insert: {
          cumulative_spend_jpy?: number
          current_tier_id: string
          customer_id: string
          downgrade_spend_baseline?: number | null
          earned_tier_id: string
          enrolled_at?: string
          id?: string
          is_downgraded?: boolean
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number
          total_points_earned?: number
          total_points_expired?: number
          total_points_redeemed?: number
          updated_at?: string
        }
        Update: {
          cumulative_spend_jpy?: number
          current_tier_id?: string
          customer_id?: string
          downgrade_spend_baseline?: number | null
          earned_tier_id?: string
          enrolled_at?: string
          id?: string
          is_downgraded?: boolean
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number
          total_points_earned?: number
          total_points_expired?: number
          total_points_redeemed?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_members_current_tier_id_fkey"
            columns: ["current_tier_id"]
            isOneToOne: false
            referencedRelation: "loyalty_tiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_members_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_members_earned_tier_id_fkey"
            columns: ["earned_tier_id"]
            isOneToOne: false
            referencedRelation: "loyalty_tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_members_backup_pre_migration: {
        Row: {
          cumulative_spend_jpy: number | null
          current_tier_id: string | null
          customer_id: string | null
          earned_tier_id: string | null
          enrolled_at: string | null
          id: string | null
          is_downgraded: boolean | null
          last_purchase_at: string | null
          pre_expiry_warned_at: string | null
          prev_purchase_at: string | null
          remaining_points: number | null
          total_points_earned: number | null
          total_points_expired: number | null
          total_points_redeemed: number | null
          updated_at: string | null
        }
        Insert: {
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Update: {
          cumulative_spend_jpy?: number | null
          current_tier_id?: string | null
          customer_id?: string | null
          earned_tier_id?: string | null
          enrolled_at?: string | null
          id?: string | null
          is_downgraded?: boolean | null
          last_purchase_at?: string | null
          pre_expiry_warned_at?: string | null
          prev_purchase_at?: string | null
          remaining_points?: number | null
          total_points_earned?: number | null
          total_points_expired?: number | null
          total_points_redeemed?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      loyalty_notification_recipients: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          member_id: string
          notification_id: string
          read_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          member_id: string
          notification_id: string
          read_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          member_id?: string
          notification_id?: string
          read_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_notification_recipients_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_notification_recipients_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "loyalty_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_notifications: {
        Row: {
          audience_member_ids: string[] | null
          audience_tiers: string[] | null
          audience_type: string
          body: string
          category: string
          created_at: string
          created_by_user_id: string | null
          email_sent: boolean
          expires_at: string | null
          id: string
          link_target: string | null
          scheduled_for: string | null
          send_email: boolean
          sent_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          audience_member_ids?: string[] | null
          audience_tiers?: string[] | null
          audience_type: string
          body: string
          category: string
          created_at?: string
          created_by_user_id?: string | null
          email_sent?: boolean
          expires_at?: string | null
          id?: string
          link_target?: string | null
          scheduled_for?: string | null
          send_email?: boolean
          sent_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          audience_member_ids?: string[] | null
          audience_tiers?: string[] | null
          audience_type?: string
          body?: string
          category?: string
          created_at?: string
          created_by_user_id?: string | null
          email_sent?: boolean
          expires_at?: string | null
          id?: string
          link_target?: string | null
          scheduled_for?: string | null
          send_email?: boolean
          sent_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      loyalty_point_lots: {
        Row: {
          consumed_at: string | null
          created_at: string
          earned_at: string
          expired_at: string | null
          expires_at: string | null
          id: string
          member_id: string
          notes: string | null
          original_amount: number
          remaining_amount: number
          revoked_at: string | null
          revoked_by_transaction_id: string | null
          source_reference: string | null
          source_type: Database["public"]["Enums"]["loyalty_lot_source_type"]
          spend_basis_jpy: number | null
          updated_at: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          earned_at?: string
          expired_at?: string | null
          expires_at?: string | null
          id?: string
          member_id: string
          notes?: string | null
          original_amount: number
          remaining_amount: number
          revoked_at?: string | null
          revoked_by_transaction_id?: string | null
          source_reference?: string | null
          source_type: Database["public"]["Enums"]["loyalty_lot_source_type"]
          spend_basis_jpy?: number | null
          updated_at?: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          earned_at?: string
          expired_at?: string | null
          expires_at?: string | null
          id?: string
          member_id?: string
          notes?: string | null
          original_amount?: number
          remaining_amount?: number
          revoked_at?: string | null
          revoked_by_transaction_id?: string | null
          source_reference?: string | null
          source_type?: Database["public"]["Enums"]["loyalty_lot_source_type"]
          spend_basis_jpy?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_point_lots_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_point_lots_revoked_by_transaction_id_fkey"
            columns: ["revoked_by_transaction_id"]
            isOneToOne: false
            referencedRelation: "loyalty_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_point_lots_backup_pre_migration: {
        Row: {
          consumed_at: string | null
          created_at: string | null
          earned_at: string | null
          expired_at: string | null
          expires_at: string | null
          id: string | null
          member_id: string | null
          notes: string | null
          original_amount: number | null
          remaining_amount: number | null
          revoked_at: string | null
          revoked_by_transaction_id: string | null
          source_reference: string | null
          source_type:
            | Database["public"]["Enums"]["loyalty_lot_source_type"]
            | null
          spend_basis_jpy: number | null
          updated_at: string | null
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string | null
          earned_at?: string | null
          expired_at?: string | null
          expires_at?: string | null
          id?: string | null
          member_id?: string | null
          notes?: string | null
          original_amount?: number | null
          remaining_amount?: number | null
          revoked_at?: string | null
          revoked_by_transaction_id?: string | null
          source_reference?: string | null
          source_type?:
            | Database["public"]["Enums"]["loyalty_lot_source_type"]
            | null
          spend_basis_jpy?: number | null
          updated_at?: string | null
        }
        Update: {
          consumed_at?: string | null
          created_at?: string | null
          earned_at?: string | null
          expired_at?: string | null
          expires_at?: string | null
          id?: string | null
          member_id?: string | null
          notes?: string | null
          original_amount?: number | null
          remaining_amount?: number | null
          revoked_at?: string | null
          revoked_by_transaction_id?: string | null
          source_reference?: string | null
          source_type?:
            | Database["public"]["Enums"]["loyalty_lot_source_type"]
            | null
          spend_basis_jpy?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      loyalty_promos: {
        Row: {
          applicable_tiers: string[] | null
          applies_per_purchase: boolean
          bonus_multiplier: number
          bonus_points: number
          created_at: string
          created_by_user_id: string | null
          description: string | null
          display_priority: number
          end_date: string
          id: string
          image_url: string | null
          is_active: boolean
          max_per_customer: number | null
          name: string
          start_date: string
          updated_at: string
        }
        Insert: {
          applicable_tiers?: string[] | null
          applies_per_purchase?: boolean
          bonus_multiplier?: number
          bonus_points?: number
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          display_priority?: number
          end_date: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          max_per_customer?: number | null
          name: string
          start_date: string
          updated_at?: string
        }
        Update: {
          applicable_tiers?: string[] | null
          applies_per_purchase?: boolean
          bonus_multiplier?: number
          bonus_points?: number
          created_at?: string
          created_by_user_id?: string | null
          description?: string | null
          display_priority?: number
          end_date?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          max_per_customer?: number | null
          name?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      loyalty_redemptions: {
        Row: {
          account_id: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by_user_id: string | null
          cash_order_id: string | null
          created_at: string
          created_by_user_id: string | null
          id: string
          invoice_number: string | null
          member_id: string
          notes: string | null
          points_redeemed: number
          processed_at: string | null
          processed_by_user_id: string | null
          rate_snapshot: number | null
          redemption_type: Database["public"]["Enums"]["loyalty_redemption_type"]
          reward_id: string | null
          status: Database["public"]["Enums"]["loyalty_redemption_status"]
          transaction_id: string | null
          value_applied_jpy: number
          value_applied_php: number | null
        }
        Insert: {
          account_id?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          member_id: string
          notes?: string | null
          points_redeemed: number
          processed_at?: string | null
          processed_by_user_id?: string | null
          rate_snapshot?: number | null
          redemption_type: Database["public"]["Enums"]["loyalty_redemption_type"]
          reward_id?: string | null
          status?: Database["public"]["Enums"]["loyalty_redemption_status"]
          transaction_id?: string | null
          value_applied_jpy: number
          value_applied_php?: number | null
        }
        Update: {
          account_id?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          member_id?: string
          notes?: string | null
          points_redeemed?: number
          processed_at?: string | null
          processed_by_user_id?: string | null
          rate_snapshot?: number | null
          redemption_type?: Database["public"]["Enums"]["loyalty_redemption_type"]
          reward_id?: string | null
          status?: Database["public"]["Enums"]["loyalty_redemption_status"]
          transaction_id?: string | null
          value_applied_jpy?: number
          value_applied_php?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_redemptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_reward_id_fkey"
            columns: ["reward_id"]
            isOneToOne: false
            referencedRelation: "loyalty_rewards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_redemptions_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "loyalty_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_rewards: {
        Row: {
          category: string
          created_at: string
          created_by_user_id: string | null
          current_stock: number | null
          description: string | null
          display_priority: number
          id: string
          image_url: string | null
          is_active: boolean
          is_limited: boolean
          is_vault: boolean
          is_vip_only: boolean
          name: string
          points_cost: number
          stock_limit: number | null
          tier_visibility: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by_user_id?: string | null
          current_stock?: number | null
          description?: string | null
          display_priority?: number
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_limited?: boolean
          is_vault?: boolean
          is_vip_only?: boolean
          name: string
          points_cost?: number
          stock_limit?: number | null
          tier_visibility?: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by_user_id?: string | null
          current_stock?: number | null
          description?: string | null
          display_priority?: number
          id?: string
          image_url?: string | null
          is_active?: boolean
          is_limited?: boolean
          is_vault?: boolean
          is_vip_only?: boolean
          name?: string
          points_cost?: number
          stock_limit?: number | null
          tier_visibility?: string
          updated_at?: string
        }
        Relationships: []
      }
      loyalty_tiers: {
        Row: {
          benefits: Json
          birthday_bonus_points: number
          color_hex: string | null
          created_at: string
          display_order: number
          free_shipping_min_items: number | null
          id: string
          min_spend_jpy: number
          mystery_gift: boolean
          name: string
          points_multiplier: number
          requalify_spend_jpy: number | null
        }
        Insert: {
          benefits?: Json
          birthday_bonus_points?: number
          color_hex?: string | null
          created_at?: string
          display_order: number
          free_shipping_min_items?: number | null
          id?: string
          min_spend_jpy: number
          mystery_gift?: boolean
          name: string
          points_multiplier: number
          requalify_spend_jpy?: number | null
        }
        Update: {
          benefits?: Json
          birthday_bonus_points?: number
          color_hex?: string | null
          created_at?: string
          display_order?: number
          free_shipping_min_items?: number | null
          id?: string
          min_spend_jpy?: number
          mystery_gift?: boolean
          name?: string
          points_multiplier?: number
          requalify_spend_jpy?: number | null
        }
        Relationships: []
      }
      loyalty_transactions: {
        Row: {
          account_id: string | null
          cash_order_id: string | null
          created_at: string
          created_by_user_id: string | null
          id: string
          invoice_number: string | null
          member_id: string
          notes: string | null
          payment_id: string | null
          points_amount: number
          promo_id: string | null
          rate_snapshot: number | null
          spend_amount_jpy: number | null
          synced_to_sheet_at: string | null
          tier_at_time: string | null
          transaction_type: Database["public"]["Enums"]["loyalty_transaction_type"]
        }
        Insert: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          member_id: string
          notes?: string | null
          payment_id?: string | null
          points_amount: number
          promo_id?: string | null
          rate_snapshot?: number | null
          spend_amount_jpy?: number | null
          synced_to_sheet_at?: string | null
          tier_at_time?: string | null
          transaction_type: Database["public"]["Enums"]["loyalty_transaction_type"]
        }
        Update: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          member_id?: string
          notes?: string | null
          payment_id?: string | null
          points_amount?: number
          promo_id?: string | null
          rate_snapshot?: number | null
          spend_amount_jpy?: number | null
          synced_to_sheet_at?: string | null
          tier_at_time?: string | null
          transaction_type?: Database["public"]["Enums"]["loyalty_transaction_type"]
        }
        Relationships: [
          {
            foreignKeyName: "fk_loyalty_tx_promo"
            columns: ["promo_id"]
            isOneToOne: false
            referencedRelation: "loyalty_promos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "loyalty_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_transactions_backup_pre_migration: {
        Row: {
          account_id: string | null
          cash_order_id: string | null
          created_at: string | null
          created_by_user_id: string | null
          id: string | null
          invoice_number: string | null
          member_id: string | null
          notes: string | null
          payment_id: string | null
          points_amount: number | null
          promo_id: string | null
          rate_snapshot: number | null
          spend_amount_jpy: number | null
          tier_at_time: string | null
          transaction_type:
            | Database["public"]["Enums"]["loyalty_transaction_type"]
            | null
        }
        Insert: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string | null
          invoice_number?: string | null
          member_id?: string | null
          notes?: string | null
          payment_id?: string | null
          points_amount?: number | null
          promo_id?: string | null
          rate_snapshot?: number | null
          spend_amount_jpy?: number | null
          tier_at_time?: string | null
          transaction_type?:
            | Database["public"]["Enums"]["loyalty_transaction_type"]
            | null
        }
        Update: {
          account_id?: string | null
          cash_order_id?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string | null
          invoice_number?: string | null
          member_id?: string | null
          notes?: string | null
          payment_id?: string | null
          points_amount?: number | null
          promo_id?: string | null
          rate_snapshot?: number | null
          spend_amount_jpy?: number | null
          tier_at_time?: string | null
          transaction_type?:
            | Database["public"]["Enums"]["loyalty_transaction_type"]
            | null
        }
        Relationships: []
      }
      notify_loyalty_launch: {
        Row: {
          created_at: string
          customer_id: string | null
          email: string
          id: string
          notes: string | null
          notified_at: string | null
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          email: string
          id?: string
          notes?: string | null
          notified_at?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          email?: string
          id?: string
          notes?: string | null
          notified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notify_loyalty_launch_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pancake_events: {
        Row: {
          attempts: number
          error_detail: string | null
          event_type: string
          event_updated_at: string
          id: string
          pancake_order_id: string
          processed_at: string | null
          raw_payload: Json
          received_at: string
          status: string
          system_id: number | null
        }
        Insert: {
          attempts?: number
          error_detail?: string | null
          event_type: string
          event_updated_at: string
          id?: string
          pancake_order_id: string
          processed_at?: string | null
          raw_payload: Json
          received_at?: string
          status?: string
          system_id?: number | null
        }
        Update: {
          attempts?: number
          error_detail?: string | null
          event_type?: string
          event_updated_at?: string
          id?: string
          pancake_order_id?: string
          processed_at?: string | null
          raw_payload?: Json
          received_at?: string
          status?: string
          system_id?: number | null
        }
        Relationships: []
      }
      payment_allocations: {
        Row: {
          allocated_amount: number
          allocation_type: Database["public"]["Enums"]["allocation_type"]
          created_at: string
          id: string
          payment_id: string
          schedule_id: string
        }
        Insert: {
          allocated_amount: number
          allocation_type: Database["public"]["Enums"]["allocation_type"]
          created_at?: string
          id?: string
          payment_id: string
          schedule_id: string
        }
        Update: {
          allocated_amount?: number
          allocation_type?: Database["public"]["Enums"]["allocation_type"]
          created_at?: string
          id?: string
          payment_id?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_history_backup: {
        Row: {
          account_id: string
          amount: number
          approved_at: string | null
          approved_by: string | null
          approved_by_name: string | null
          backed_up_at: string
          currency: string
          customer_name: string | null
          event_type: string
          id: string
          invoice_number: string
          notes: string | null
          payment_date: string
          payment_id: string
          payment_method: string | null
          status: string
          submission_type: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
          voided_by_name: string | null
        }
        Insert: {
          account_id: string
          amount: number
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          backed_up_at?: string
          currency: string
          customer_name?: string | null
          event_type: string
          id?: string
          invoice_number: string
          notes?: string | null
          payment_date: string
          payment_id: string
          payment_method?: string | null
          status: string
          submission_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          voided_by_name?: string | null
        }
        Update: {
          account_id?: string
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          backed_up_at?: string
          currency?: string
          customer_name?: string | null
          event_type?: string
          id?: string
          invoice_number?: string
          notes?: string | null
          payment_date?: string
          payment_id?: string
          payment_method?: string | null
          status?: string
          submission_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
          voided_by_name?: string | null
        }
        Relationships: []
      }
      payment_methods: {
        Row: {
          account_name: string | null
          account_number: string | null
          bank_name: string | null
          created_at: string
          id: string
          instructions: string | null
          is_active: boolean
          method_name: string
          qr_image_url: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          account_name?: string | null
          account_number?: string | null
          bank_name?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          method_name: string
          qr_image_url?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          account_name?: string | null
          account_number?: string | null
          bank_name?: string | null
          created_at?: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          method_name?: string
          qr_image_url?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      payment_proofs: {
        Row: {
          account_id: string | null
          cash_order_id: string | null
          cash_payment_id: string | null
          created_at: string
          file_name: string | null
          file_url: string
          id: string
          installment_number: number | null
          payment_id: string | null
          submission_date: string | null
          uploaded_by_name: string | null
          uploaded_by_user_id: string | null
        }
        Insert: {
          account_id?: string | null
          cash_order_id?: string | null
          cash_payment_id?: string | null
          created_at?: string
          file_name?: string | null
          file_url: string
          id?: string
          installment_number?: number | null
          payment_id?: string | null
          submission_date?: string | null
          uploaded_by_name?: string | null
          uploaded_by_user_id?: string | null
        }
        Update: {
          account_id?: string | null
          cash_order_id?: string | null
          cash_payment_id?: string | null
          created_at?: string
          file_name?: string | null
          file_url?: string
          id?: string
          installment_number?: number | null
          payment_id?: string | null
          submission_date?: string | null
          uploaded_by_name?: string | null
          uploaded_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_proofs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_proofs_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_proofs_cash_payment_id_fkey"
            columns: ["cash_payment_id"]
            isOneToOne: false
            referencedRelation: "cash_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_proofs_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_submission_allocations: {
        Row: {
          account_id: string
          allocated_amount: number
          created_at: string
          id: string
          invoice_number: string
          submission_id: string
        }
        Insert: {
          account_id: string
          allocated_amount: number
          created_at?: string
          id?: string
          invoice_number: string
          submission_id: string
        }
        Update: {
          account_id?: string
          allocated_amount?: number
          created_at?: string
          id?: string
          invoice_number?: string
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_submission_allocations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submission_allocations_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "payment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_submissions: {
        Row: {
          account_id: string | null
          cash_order_id: string | null
          confirmed_payment_id: string | null
          created_at: string
          customer_edited_at: string | null
          customer_id: string
          id: string
          installment_number: number | null
          notes: string | null
          payment_date: string
          payment_method: string
          portal_token: string | null
          proof_url: string | null
          reference_number: string | null
          reviewer_notes: string | null
          reviewer_user_id: string | null
          sender_name: string | null
          status: Database["public"]["Enums"]["submission_status"]
          submission_type: string
          submitted_amount: number
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          cash_order_id?: string | null
          confirmed_payment_id?: string | null
          created_at?: string
          customer_edited_at?: string | null
          customer_id: string
          id?: string
          installment_number?: number | null
          notes?: string | null
          payment_date: string
          payment_method: string
          portal_token?: string | null
          proof_url?: string | null
          reference_number?: string | null
          reviewer_notes?: string | null
          reviewer_user_id?: string | null
          sender_name?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          submission_type?: string
          submitted_amount: number
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          cash_order_id?: string | null
          confirmed_payment_id?: string | null
          created_at?: string
          customer_edited_at?: string | null
          customer_id?: string
          id?: string
          installment_number?: number | null
          notes?: string | null
          payment_date?: string
          payment_method?: string
          portal_token?: string | null
          proof_url?: string | null
          reference_number?: string | null
          reviewer_notes?: string | null
          reviewer_user_id?: string | null
          sender_name?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          submission_type?: string
          submitted_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submissions_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submissions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          account_id: string
          amount_paid: number
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          date_paid: string
          entered_by_user_id: string | null
          id: string
          payment_method: string | null
          reference_number: string | null
          remarks: string | null
          submitted_by_name: string | null
          submitted_by_type: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by_user_id: string | null
        }
        Insert: {
          account_id: string
          amount_paid: number
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          date_paid?: string
          entered_by_user_id?: string | null
          id?: string
          payment_method?: string | null
          reference_number?: string | null
          remarks?: string | null
          submitted_by_name?: string | null
          submitted_by_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_user_id?: string | null
        }
        Update: {
          account_id?: string
          amount_paid?: number
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          date_paid?: string
          entered_by_user_id?: string | null
          id?: string
          payment_method?: string | null
          reference_number?: string | null
          remarks?: string | null
          submitted_by_name?: string | null
          submitted_by_type?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      penalty_cap_overrides: {
        Row: {
          account_id: string
          applied_at: string
          applied_by_user_id: string | null
          created_at: string
          currency: string
          id: string
          is_active: boolean
          notes: string | null
          penalty_cap_amount: number
          penalty_cap_scope: string
          updated_at: string
        }
        Insert: {
          account_id: string
          applied_at?: string
          applied_by_user_id?: string | null
          created_at?: string
          currency: string
          id?: string
          is_active?: boolean
          notes?: string | null
          penalty_cap_amount: number
          penalty_cap_scope?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          applied_at?: string
          applied_by_user_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          penalty_cap_amount?: number
          penalty_cap_scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "penalty_cap_overrides_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      penalty_fees: {
        Row: {
          account_id: string
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          id: string
          penalty_amount: number
          penalty_cycle: number
          penalty_date: string
          penalty_stage: Database["public"]["Enums"]["penalty_stage"]
          schedule_id: string
          status: Database["public"]["Enums"]["penalty_fee_status"]
          updated_at: string
          waived_at: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          id?: string
          penalty_amount: number
          penalty_cycle?: number
          penalty_date?: string
          penalty_stage: Database["public"]["Enums"]["penalty_stage"]
          schedule_id: string
          status?: Database["public"]["Enums"]["penalty_fee_status"]
          updated_at?: string
          waived_at?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          id?: string
          penalty_amount?: number
          penalty_cycle?: number
          penalty_date?: string
          penalty_stage?: Database["public"]["Enums"]["penalty_stage"]
          schedule_id?: string
          status?: Database["public"]["Enums"]["penalty_fee_status"]
          updated_at?: string
          waived_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "penalty_fees_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalty_fees_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalty_fees_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      penalty_waiver_requests: {
        Row: {
          account_id: string
          approved_at: string | null
          approved_by_user_id: string | null
          auto_unwaived_at: string | null
          created_at: string
          id: string
          is_auto: boolean
          penalty_amount: number
          penalty_fee_id: string
          reason: string
          rejected_at: string | null
          requested_by_user_id: string | null
          schedule_id: string
          source_submission_id: string | null
          status: Database["public"]["Enums"]["waiver_status"]
          updated_at: string
        }
        Insert: {
          account_id: string
          approved_at?: string | null
          approved_by_user_id?: string | null
          auto_unwaived_at?: string | null
          created_at?: string
          id?: string
          is_auto?: boolean
          penalty_amount: number
          penalty_fee_id: string
          reason: string
          rejected_at?: string | null
          requested_by_user_id?: string | null
          schedule_id: string
          source_submission_id?: string | null
          status?: Database["public"]["Enums"]["waiver_status"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          approved_at?: string | null
          approved_by_user_id?: string | null
          auto_unwaived_at?: string | null
          created_at?: string
          id?: string
          is_auto?: boolean
          penalty_amount?: number
          penalty_fee_id?: string
          reason?: string
          rejected_at?: string | null
          requested_by_user_id?: string | null
          schedule_id?: string
          source_submission_id?: string | null
          status?: Database["public"]["Enums"]["waiver_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "penalty_waiver_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalty_waiver_requests_penalty_fee_id_fkey"
            columns: ["penalty_fee_id"]
            isOneToOne: false
            referencedRelation: "penalty_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalty_waiver_requests_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalty_waiver_requests_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_configurations: {
        Row: {
          created_at: string | null
          display_label: string
          dp_percentage: number
          is_active: boolean
          min_amount_jpy: number
          min_amount_php: number
          plan_months: number
          risk_tier: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          display_label: string
          dp_percentage?: number
          is_active?: boolean
          min_amount_jpy?: number
          min_amount_php?: number
          plan_months: number
          risk_tier: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          display_label?: string
          dp_percentage?: number
          is_active?: boolean
          min_amount_jpy?: number
          min_amount_php?: number
          plan_months?: number
          risk_tier?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      product_inquiries: {
        Row: {
          action_needed: string | null
          category: string
          created_at: string
          entered_by: string | null
          id: string
          inquirer_name: string | null
          inquiry_count: number
          item_code: string | null
          last_inquired_date: string | null
          order_placed: string | null
          popular_inquiries_notes: string | null
          product_name: string | null
          source: string | null
          updated_at: string
        }
        Insert: {
          action_needed?: string | null
          category?: string
          created_at?: string
          entered_by?: string | null
          id?: string
          inquirer_name?: string | null
          inquiry_count?: number
          item_code?: string | null
          last_inquired_date?: string | null
          order_placed?: string | null
          popular_inquiries_notes?: string | null
          product_name?: string | null
          source?: string | null
          updated_at?: string
        }
        Update: {
          action_needed?: string | null
          category?: string
          created_at?: string
          entered_by?: string | null
          id?: string
          inquirer_name?: string | null
          inquiry_count?: number
          item_code?: string | null
          last_inquired_date?: string | null
          order_placed?: string | null
          popular_inquiries_notes?: string | null
          product_name?: string | null
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          barcode: string | null
          collection_titles: string[] | null
          created_at: string
          description: string | null
          handle: string | null
          id: string
          image_url: string | null
          inventory_quantity: number | null
          price_jpy: number | null
          product_type: string | null
          shopify_product_id: string
          shopify_updated_at: string | null
          sku: string | null
          status: string
          synced_at: string
          tags: string[] | null
          title: string
          vendor: string | null
        }
        Insert: {
          barcode?: string | null
          collection_titles?: string[] | null
          created_at?: string
          description?: string | null
          handle?: string | null
          id?: string
          image_url?: string | null
          inventory_quantity?: number | null
          price_jpy?: number | null
          product_type?: string | null
          shopify_product_id: string
          shopify_updated_at?: string | null
          sku?: string | null
          status: string
          synced_at?: string
          tags?: string[] | null
          title: string
          vendor?: string | null
        }
        Update: {
          barcode?: string | null
          collection_titles?: string[] | null
          created_at?: string
          description?: string | null
          handle?: string | null
          id?: string
          image_url?: string | null
          inventory_quantity?: number | null
          price_jpy?: number | null
          product_type?: string | null
          shopify_product_id?: string
          shopify_updated_at?: string | null
          sku?: string | null
          status?: string
          synced_at?: string
          tags?: string[] | null
          title?: string
          vendor?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string
          id: string
          status: Database["public"]["Enums"]["user_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      promo_categories: {
        Row: {
          created_at: string | null
          created_by: string | null
          display_order: number | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      promo_category_assignments: {
        Row: {
          category_id: string
          promo_id: string
        }
        Insert: {
          category_id: string
          promo_id: string
        }
        Update: {
          category_id?: string
          promo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promo_category_assignments_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "promo_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_category_assignments_promo_id_fkey"
            columns: ["promo_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      promo_views: {
        Row: {
          category_id: string | null
          customer_id: string
          id: string
          invoice_number: string
          promo_id: string
          viewed_at: string | null
        }
        Insert: {
          category_id?: string | null
          customer_id: string
          id?: string
          invoice_number: string
          promo_id: string
          viewed_at?: string | null
        }
        Update: {
          category_id?: string | null
          customer_id?: string
          id?: string
          invoice_number?: string
          promo_id?: string
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "promo_views_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "promo_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_views_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_views_promo_id_fkey"
            columns: ["promo_id"]
            isOneToOne: false
            referencedRelation: "promotions"
            referencedColumns: ["id"]
          },
        ]
      }
      promotions: {
        Row: {
          created_at: string | null
          created_by: string | null
          currency: string | null
          description: string | null
          display_order: number | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          link_url: string | null
          media_type: string | null
          media_url: string | null
          price: number | null
          title: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          display_order?: number | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          link_url?: string | null
          media_type?: string | null
          media_url?: string | null
          price?: number | null
          title: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          description?: string | null
          display_order?: number | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          link_url?: string | null
          media_type?: string | null
          media_url?: string | null
          price?: number | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      reconciliation_log: {
        Row: {
          account_id: string | null
          checked_at: string | null
          drift: Json | null
          drift_count: number | null
          drift_detected: boolean | null
          id: string
          invoice_number: string | null
        }
        Insert: {
          account_id?: string | null
          checked_at?: string | null
          drift?: Json | null
          drift_count?: number | null
          drift_detected?: boolean | null
          id?: string
          invoice_number?: string | null
        }
        Update: {
          account_id?: string | null
          checked_at?: string | null
          drift?: Json | null
          drift_count?: number | null
          drift_detected?: boolean | null
          id?: string
          invoice_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      reminder_logs: {
        Row: {
          account_id: string
          channel: string
          created_at: string
          customer_id: string
          delivery_status: string | null
          error_message: string | null
          id: string
          message_body: string | null
          provider_message_id: string | null
          provider_name: string | null
          recipient: string | null
          schedule_id: string | null
          sent_at: string | null
          template_type: string | null
        }
        Insert: {
          account_id: string
          channel?: string
          created_at?: string
          customer_id: string
          delivery_status?: string | null
          error_message?: string | null
          id?: string
          message_body?: string | null
          provider_message_id?: string | null
          provider_name?: string | null
          recipient?: string | null
          schedule_id?: string | null
          sent_at?: string | null
          template_type?: string | null
        }
        Update: {
          account_id?: string
          channel?: string
          created_at?: string
          customer_id?: string
          delivery_status?: string | null
          error_message?: string | null
          id?: string
          message_body?: string | null
          provider_message_id?: string | null
          provider_name?: string | null
          recipient?: string | null
          schedule_id?: string | null
          sent_at?: string | null
          template_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reminder_logs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_logs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_logs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_logs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          id: string
          is_allowed: boolean
          permission_key: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          updated_by_user_id: string | null
        }
        Insert: {
          id?: string
          is_allowed?: boolean
          permission_key: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Update: {
          id?: string
          is_allowed?: boolean
          permission_key?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          updated_by_user_id?: string | null
        }
        Relationships: []
      }
      sales_log: {
        Row: {
          channel: string | null
          client_name: string | null
          closed_in_chat: boolean
          closer: string | null
          coordinator: string | null
          created_at: string
          eligible: boolean
          id: string
          invoice_number: string | null
          item_amount: number | null
          item_code: string | null
          notes: string | null
          opened_in_chat: boolean
          processor: string | null
          sale_date: string
          source: string | null
          status: string
          support: string | null
          updated_at: string
          verifier: string | null
        }
        Insert: {
          channel?: string | null
          client_name?: string | null
          closed_in_chat?: boolean
          closer?: string | null
          coordinator?: string | null
          created_at?: string
          eligible?: boolean
          id?: string
          invoice_number?: string | null
          item_amount?: number | null
          item_code?: string | null
          notes?: string | null
          opened_in_chat?: boolean
          processor?: string | null
          sale_date: string
          source?: string | null
          status?: string
          support?: string | null
          updated_at?: string
          verifier?: string | null
        }
        Update: {
          channel?: string | null
          client_name?: string | null
          closed_in_chat?: boolean
          closer?: string | null
          coordinator?: string | null
          created_at?: string
          eligible?: boolean
          id?: string
          invoice_number?: string | null
          item_amount?: number | null
          item_code?: string | null
          notes?: string | null
          opened_in_chat?: boolean
          processor?: string | null
          sale_date?: string
          source?: string | null
          status?: string
          support?: string | null
          updated_at?: string
          verifier?: string | null
        }
        Relationships: []
      }
      sales_log_backup_20260616: {
        Row: {
          channel: string | null
          client_name: string | null
          closed_in_chat: boolean | null
          closer: string | null
          coordinator: string | null
          created_at: string | null
          eligible: boolean | null
          id: string | null
          item_amount: number | null
          item_code: string | null
          notes: string | null
          opened_in_chat: boolean | null
          processor: string | null
          sale_date: string | null
          source: string | null
          status: string | null
          support: string | null
          updated_at: string | null
          verifier: string | null
        }
        Insert: {
          channel?: string | null
          client_name?: string | null
          closed_in_chat?: boolean | null
          closer?: string | null
          coordinator?: string | null
          created_at?: string | null
          eligible?: boolean | null
          id?: string | null
          item_amount?: number | null
          item_code?: string | null
          notes?: string | null
          opened_in_chat?: boolean | null
          processor?: string | null
          sale_date?: string | null
          source?: string | null
          status?: string | null
          support?: string | null
          updated_at?: string | null
          verifier?: string | null
        }
        Update: {
          channel?: string | null
          client_name?: string | null
          closed_in_chat?: boolean | null
          closer?: string | null
          coordinator?: string | null
          created_at?: string | null
          eligible?: boolean | null
          id?: string | null
          item_amount?: number | null
          item_code?: string | null
          notes?: string | null
          opened_in_chat?: boolean | null
          processor?: string | null
          sale_date?: string | null
          source?: string | null
          status?: string | null
          support?: string | null
          updated_at?: string | null
          verifier?: string | null
        }
        Relationships: []
      }
      schedule_audit_log: {
        Row: {
          account_id: string
          action: string
          admin_user_id: string | null
          created_at: string | null
          field_changed: string | null
          id: string
          new_value: string | null
          old_value: string | null
          reason: string
          schedule_id: string
        }
        Insert: {
          account_id: string
          action: string
          admin_user_id?: string | null
          created_at?: string | null
          field_changed?: string | null
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason: string
          schedule_id: string
        }
        Update: {
          account_id?: string
          action?: string
          admin_user_id?: string | null
          created_at?: string | null
          field_changed?: string | null
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string
          schedule_id?: string
        }
        Relationships: []
      }
      service_jobs: {
        Row: {
          account_type: string
          created_at: string
          created_by_user_id: string | null
          customer_id: string
          date_completed: string | null
          date_received: string
          estimated_completion: string | null
          id: string
          invoice_number: string | null
          notes: string | null
          service_description: string
          service_fee: number
          service_status: Database["public"]["Enums"]["service_status"]
          service_type: Database["public"]["Enums"]["service_type"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account_type: string
          created_at?: string
          created_by_user_id?: string | null
          customer_id: string
          date_completed?: string | null
          date_received?: string
          estimated_completion?: string | null
          id?: string
          invoice_number?: string | null
          notes?: string | null
          service_description: string
          service_fee?: number
          service_status?: Database["public"]["Enums"]["service_status"]
          service_type: Database["public"]["Enums"]["service_type"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account_type?: string
          created_at?: string
          created_by_user_id?: string | null
          customer_id?: string
          date_completed?: string | null
          date_received?: string
          estimated_completion?: string | null
          id?: string
          invoice_number?: string | null
          notes?: string | null
          service_description?: string
          service_fee?: number
          service_status?: Database["public"]["Enums"]["service_status"]
          service_type?: Database["public"]["Enums"]["service_type"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_webhook_events: {
        Row: {
          error_detail: string | null
          id: string
          processed_at: string
          shopify_order_id: string
          status: string
          topic: string
          webhook_id: string | null
        }
        Insert: {
          error_detail?: string | null
          id?: string
          processed_at?: string
          shopify_order_id: string
          status?: string
          topic: string
          webhook_id?: string | null
        }
        Update: {
          error_detail?: string | null
          id?: string
          processed_at?: string
          shopify_order_id?: string
          status?: string
          topic?: string
          webhook_id?: string | null
        }
        Relationships: []
      }
      staff_notification_reads: {
        Row: {
          notification_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          notification_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          notification_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "staff_notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_notifications: {
        Row: {
          account_id: string | null
          body: string | null
          created_at: string
          customer_id: string | null
          id: string
          invoice_number: string | null
          metadata: Json
          title: string
          type: string
        }
        Insert: {
          account_id?: string | null
          body?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          invoice_number?: string | null
          metadata?: Json
          title: string
          type: string
        }
        Update: {
          account_id?: string | null
          body?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          invoice_number?: string | null
          metadata?: Json
          title?: string
          type?: string
        }
        Relationships: []
      }
      store_credit_lots: {
        Row: {
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          expires_at: string
          id: string
          issued_at: string
          issued_by_user_id: string | null
          notes: string | null
          original_amount: number
          rate_snapshot: number | null
          remaining_amount: number
          source_account_id: string | null
          source_cash_order_id: string | null
          source_refund_id: string | null
          source_type: string
          status: Database["public"]["Enums"]["store_credit_lot_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          expires_at: string
          id?: string
          issued_at?: string
          issued_by_user_id?: string | null
          notes?: string | null
          original_amount: number
          rate_snapshot?: number | null
          remaining_amount: number
          source_account_id?: string | null
          source_cash_order_id?: string | null
          source_refund_id?: string | null
          source_type: string
          status?: Database["public"]["Enums"]["store_credit_lot_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          expires_at?: string
          id?: string
          issued_at?: string
          issued_by_user_id?: string | null
          notes?: string | null
          original_amount?: number
          rate_snapshot?: number | null
          remaining_amount?: number
          source_account_id?: string | null
          source_cash_order_id?: string | null
          source_refund_id?: string | null
          source_type?: string
          status?: Database["public"]["Enums"]["store_credit_lot_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_credit_lots_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_lots_source_account_id_fkey"
            columns: ["source_account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_lots_source_cash_order_id_fkey"
            columns: ["source_cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      store_credit_reconciliation: {
        Row: {
          checked_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          delta: number | null
          detail: string | null
          hub_balance: number
          id: string
          run_id: string
          shopify_balance: number | null
          shopify_customer_id: string | null
          status: string
        }
        Insert: {
          checked_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          delta?: number | null
          detail?: string | null
          hub_balance?: number
          id?: string
          run_id: string
          shopify_balance?: number | null
          shopify_customer_id?: string | null
          status: string
        }
        Update: {
          checked_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          delta?: number | null
          detail?: string | null
          hub_balance?: number
          id?: string
          run_id?: string
          shopify_balance?: number | null
          shopify_customer_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_credit_reconciliation_customer_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      store_credit_shopify_sync: {
        Row: {
          amount: number
          attempts: number
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          direction: string
          error_detail: string | null
          id: string
          lot_id: string | null
          reason: string | null
          shopify_balance_after: number | null
          shopify_customer_id: string | null
          shopify_transaction_id: string | null
          status: string
          synced_at: string | null
        }
        Insert: {
          amount: number
          attempts?: number
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          direction: string
          error_detail?: string | null
          id?: string
          lot_id?: string | null
          reason?: string | null
          shopify_balance_after?: number | null
          shopify_customer_id?: string | null
          shopify_transaction_id?: string | null
          status?: string
          synced_at?: string | null
        }
        Update: {
          amount?: number
          attempts?: number
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          direction?: string
          error_detail?: string | null
          id?: string
          lot_id?: string | null
          reason?: string | null
          shopify_balance_after?: number | null
          shopify_customer_id?: string | null
          shopify_transaction_id?: string | null
          status?: string
          synced_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_credit_shopify_sync_customer_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_shopify_sync_lot_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "store_credit_lots"
            referencedColumns: ["id"]
          },
        ]
      }
      store_credit_transactions: {
        Row: {
          account_id: string | null
          amount: number
          balance_after: number | null
          cash_order_id: string | null
          created_at: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          id: string
          lot_id: string | null
          notes: string | null
          performed_by_user_id: string | null
          txn_type: Database["public"]["Enums"]["store_credit_txn_type"]
        }
        Insert: {
          account_id?: string | null
          amount: number
          balance_after?: number | null
          cash_order_id?: string | null
          created_at?: string
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          id?: string
          lot_id?: string | null
          notes?: string | null
          performed_by_user_id?: string | null
          txn_type: Database["public"]["Enums"]["store_credit_txn_type"]
        }
        Update: {
          account_id?: string | null
          amount?: number
          balance_after?: number | null
          cash_order_id?: string | null
          created_at?: string
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          id?: string
          lot_id?: string | null
          notes?: string | null
          performed_by_user_id?: string | null
          txn_type?: Database["public"]["Enums"]["store_credit_txn_type"]
        }
        Relationships: [
          {
            foreignKeyName: "store_credit_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_transactions_cash_order_id_fkey"
            columns: ["cash_order_id"]
            isOneToOne: false
            referencedRelation: "cash_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_credit_transactions_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "store_credit_lots"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string
          updated_by_user_id: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          updated_by_user_id?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          updated_by_user_id?: string | null
          value?: Json
        }
        Relationships: []
      }
      timesheet_entries: {
        Row: {
          am_in: string | null
          am_out: string | null
          created_at: string
          id: string
          note: string | null
          pm_in: string | null
          pm_out: string | null
          updated_at: string
          user_id: string
          work_date: string
        }
        Insert: {
          am_in?: string | null
          am_out?: string | null
          created_at?: string
          id?: string
          note?: string | null
          pm_in?: string | null
          pm_out?: string | null
          updated_at?: string
          user_id: string
          work_date: string
        }
        Update: {
          am_in?: string | null
          am_out?: string | null
          created_at?: string
          id?: string
          note?: string | null
          pm_in?: string | null
          pm_out?: string | null
          updated_at?: string
          user_id?: string
          work_date?: string
        }
        Relationships: []
      }
      timesheet_monthly_history: {
        Row: {
          created_at: string
          csr_net: number
          liveadmin_net: number
          month_key: string
        }
        Insert: {
          created_at?: string
          csr_net?: number
          liveadmin_net?: number
          month_key: string
        }
        Update: {
          created_at?: string
          csr_net?: number
          liveadmin_net?: number
          month_key?: string
        }
        Relationships: []
      }
      timesheet_profiles: {
        Row: {
          active: boolean
          allowance: number | null
          basic_salary: number | null
          can_view_all: boolean
          created_at: string
          dayoff_divisor: number
          full_day_rate: number | null
          full_day_threshold_hours: number | null
          half_day_rate: number | null
          id: string
          job_title: string | null
          shift_end: string | null
          shift_start: string | null
          template_type: string
          timezone: string
          updated_at: string
          user_id: string
          work_days: number[]
        }
        Insert: {
          active?: boolean
          allowance?: number | null
          basic_salary?: number | null
          can_view_all?: boolean
          created_at?: string
          dayoff_divisor?: number
          full_day_rate?: number | null
          full_day_threshold_hours?: number | null
          half_day_rate?: number | null
          id?: string
          job_title?: string | null
          shift_end?: string | null
          shift_start?: string | null
          template_type: string
          timezone?: string
          updated_at?: string
          user_id: string
          work_days?: number[]
        }
        Update: {
          active?: boolean
          allowance?: number | null
          basic_salary?: number | null
          can_view_all?: boolean
          created_at?: string
          dayoff_divisor?: number
          full_day_rate?: number | null
          full_day_threshold_hours?: number | null
          half_day_rate?: number | null
          id?: string
          job_title?: string | null
          shift_end?: string | null
          shift_start?: string | null
          template_type?: string
          timezone?: string
          updated_at?: string
          user_id?: string
          work_days?: number[]
        }
        Relationships: []
      }
      trade_ins: {
        Row: {
          created_at: string
          customer_id: string
          date_trade: string
          id: string
          item_code: string
          item_description: string
          new_invoice_number: string | null
          notes: string | null
          old_invoice_number: string
          resale_amount: number | null
          resale_status: Database["public"]["Enums"]["resale_status"]
          trade_amount: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          date_trade?: string
          id?: string
          item_code: string
          item_description: string
          new_invoice_number?: string | null
          notes?: string | null
          old_invoice_number: string
          resale_amount?: number | null
          resale_status?: Database["public"]["Enums"]["resale_status"]
          trade_amount?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          date_trade?: string
          id?: string
          item_code?: string
          item_description?: string
          new_invoice_number?: string | null
          notes?: string | null
          old_invoice_number?: string
          resale_amount?: number | null
          resale_status?: Database["public"]["Enums"]["resale_status"]
          trade_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_ins_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_permission_overrides: {
        Row: {
          created_at: string | null
          granted: boolean
          id: string
          permission_key: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          granted: boolean
          id?: string
          permission_key: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          granted?: boolean
          id?: string
          permission_key?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      product_inquiries_with_accumulated: {
        Row: {
          accumulated_inquiry_count: number | null
          action_needed: string | null
          category: string | null
          created_at: string | null
          entered_by: string | null
          id: string | null
          inquirer_name: string | null
          inquiry_count: number | null
          item_code: string | null
          last_inquired_date: string | null
          order_placed: string | null
          popular_inquiries_notes: string | null
          product_name: string | null
          source: string | null
          updated_at: string | null
        }
        Relationships: []
      }
      schedule_with_actuals: {
        Row: {
          account_id: string | null
          actual_remaining: number | null
          allocated: number | null
          base_installment_amount: number | null
          carried_amount: number | null
          carried_by_payment_id: string | null
          carried_from_schedule_id: string | null
          computed_status: Database["public"]["Enums"]["schedule_status"] | null
          currency: Database["public"]["Enums"]["account_currency"] | null
          db_status: Database["public"]["Enums"]["schedule_status"] | null
          due_date: string | null
          generated_at: string | null
          id: string | null
          installment_number: number | null
          penalty_amount: number | null
          total_due_amount: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "layaway_schedule_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "layaway_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_by_payment_id_fkey"
            columns: ["carried_by_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_from_schedule_id_fkey"
            columns: ["carried_from_schedule_id"]
            isOneToOne: false
            referencedRelation: "layaway_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layaway_schedule_carried_from_schedule_id_fkey"
            columns: ["carried_from_schedule_id"]
            isOneToOne: false
            referencedRelation: "schedule_with_actuals"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _award_birthday_reward: { Args: { p_customer_id: string }; Returns: Json }
      admin_correct_birthday: {
        Args: { p_birthday: string; p_customer_id: string }
        Returns: Json
      }
      admin_keep_allocation_override: {
        Args: { p_allocation_id: string; p_amount: number }
        Returns: undefined
      }
      admin_renumber_installment: {
        Args: { p_new_number: number; p_schedule_id: string }
        Returns: undefined
      }
      admin_update_schedule_base: {
        Args: {
          p_is_paid: boolean
          p_new_base: number
          p_new_total_due: number
          p_schedule_id: string
        }
        Returns: undefined
      }
      allocate_payment_atomic: {
        Args: {
          p_account_id: string
          p_amount_paid: number
          p_currency: string
          p_is_downpayment?: boolean
          p_payment_date: string
          p_payment_method: string
          p_preview?: boolean
          p_reference_number: string
          p_remarks: string
          p_submitted_by_name?: string
          p_submitted_by_type?: string
          p_user_id: string
        }
        Returns: Json
      }
      approve_redemption_atomic: {
        Args: {
          p_redemption_id: string
          p_user_email: string
          p_user_id: string
        }
        Returns: Json
      }
      audit_account: { Args: { p_invoice_number: string }; Returns: Json }
      audit_all_accounts: {
        Args: never
        Returns: {
          all_pass: boolean
          failed_checks: string[]
          invoice_number: string
          status: string
        }[]
      }
      audit_delete_cleanup_invariants: {
        Args: never
        Returns: {
          child_table: string
          delete_function: string
          finding_type: string
          fk_name: string
          in_allowlist: boolean
          message: string
          on_delete: string
          parent_table: string
          severity: string
        }[]
      }
      cancel_cash_order_atomic: {
        Args: {
          p_cash_order_id: string
          p_preview?: boolean
          p_reason: string
          p_source?: string
          p_user_email?: string
          p_user_id?: string
        }
        Returns: Json
      }
      check_customer_email_conflict: {
        Args: { p_customer_id: string }
        Returns: string
      }
      check_duplicate_payment: {
        Args: { p_account_id: string; p_amount: number; p_date?: string }
        Returns: Json
      }
      consume_lots_fifo: {
        Args: { p_amount: number; p_member_id: string; p_redemption_id: string }
        Returns: number
      }
      consume_store_credit_for_shopify_atomic: {
        Args: {
          p_amount: number
          p_cash_order_id?: string
          p_currency: Database["public"]["Enums"]["account_currency"]
          p_customer_id: string
          p_shopify_reference?: string
          p_source?: string
        }
        Returns: Json
      }
      deactivate_expired_promotions: { Args: never; Returns: undefined }
      delete_account_atomic: {
        Args: { p_account_id: string; p_performed_by_user_id?: string }
        Returns: Json
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      delete_schedule_row_atomic: {
        Args: {
          p_account_id: string
          p_admin_user_id: string
          p_old_base_amount: number
          p_reason: string
          p_schedule_row_id: string
        }
        Returns: Json
      }
      derive_cash_order_loyalty_jpy: {
        Args: { p_cash_order_id: string }
        Returns: number
      }
      derive_order_loyalty_jpy: {
        Args: { p_account_id: string }
        Returns: number
      }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      fc_at_risk_accounts: {
        Args: never
        Returns: {
          active_total: number
          at_risk_pct: number
          critical_count: number
          total_at_risk: number
        }[]
      }
      fc_at_risk_detail: {
        Args: never
        Returns: {
          invoice_number: string
          outstanding_jpy: number
          overdue_days: number
          penalty_count: number
          plan_months: number
          risk_level: string
          risk_score: number
          risk_type: string
        }[]
      }
      fc_cfo_insights: {
        Args: never
        Returns: {
          action: string
          category: string
          impact_magnitude: number
          implication: string
          observation: string
          primary_driver: string
          priority: number
          req_accounts_10m: number
          req_accounts_8m: number
        }[]
      }
      fc_cohort_timeline: {
        Args: never
        Returns: {
          account_count: number
          actual_collected: number
          at_risk_rate: number
          at_risk_rate_trend: number
          average_ticket: number
          cohort_age_days: number
          cohort_month: string
          collection_rate: number
          collection_rate_delta: number
          delinquent_count: number
          directional_impact: number
          expected_collected: number
          expected_progress_pct: number
          impact_score: number
          penalty_rate: number
          penalty_rate_trend: number
          plan_months: number
          quality_adjusted_collection: number
          reliability_score: number
          total_value_jpy: number
          variance_pct: number
        }[]
      }
      fc_coverage_ratio: {
        Args: never
        Returns: {
          cash_in: number
          coverage_ratio: number
          days_covered: number
          funding_gap: number
          inventory_cost: number
          projected_coverage_30d: number
          projected_funding_gap: number
          projected_inflow_30d: number
          status_label: string
        }[]
      }
      fc_evaluate_alerts: { Args: never; Returns: undefined }
      fc_gross_profit: {
        Args: never
        Returns: {
          active_gross_profit: number
          lifetime_gross_profit: number
        }[]
      }
      fc_monthly_inflow: {
        Args: { target_month?: string }
        Returns: {
          installment_inflow: number
          penalty_inflow: number
          total_inflow: number
        }[]
      }
      fc_net_exposure_risk: {
        Args: { resale_pct?: number }
        Returns: {
          at_risk_exposure: number
          critical_exposure: number
          delta_at_risk: number
          delta_critical: number
          delta_healthy: number
          delta_pct: number
          dp_retained: number
          estimated_resale: number
          exposure_change: number
          gross_exposure: number
          healthy_exposure: number
          net_exposure: number
          penalties_collected: number
          prior_month_exposure: number
        }[]
      }
      fc_penalty_driven_accounts: {
        Args: never
        Returns: {
          pct_of_active: number
          penalty_driven_count: number
          penalty_revenue_contribution: number
        }[]
      }
      fc_penalty_revenue: {
        Args: never
        Returns: {
          cumulative_jpy: number
          current_month_jpy: number
          penalty_pct_of_inflow: number
        }[]
      }
      fc_plan_performance: {
        Args: never
        Returns: {
          account_count: number
          avg_ticket_jpy: number
          contribution_pct: number
          default_rate: number
          display_label: string
          excess_pct: number
          gross_profit: number
          min_amount_jpy: number
          monthly_inflow: number
          plan_at_risk_rate: number
          plan_months: number
          plan_penalty_rate: number
          plan_quality_score: number
          portfolio_jpy: number
          required_shift: number
          risk_adjusted_profit: number
          risk_tier: string
          target_mix_pct: number
        }[]
      }
      fc_portfolio_value: { Args: never; Returns: number }
      get_aging_buckets: {
        Args: { p_scope?: string }
        Returns: {
          account_count: number
          amount: number
          bucket: string
          currency: string
        }[]
      }
      get_audit_filter_options: { Args: never; Returns: Json }
      get_bulk_setup_invite_candidates: {
        Args: {
          p_count_only?: boolean
          p_limit?: number
          p_test_codes?: string[]
        }
        Returns: {
          customer_code: string
          email: string
          full_name: string
          id: string
          total_eligible: number
        }[]
      }
      get_cash_orders_monthly: {
        Args: never
        Returns: {
          cash_jpy: number
          month: string
          order_count: number
        }[]
      }
      get_collection_analytics: {
        Args: { currency_mode?: string; months_back?: number }
        Returns: Json
      }
      get_daily_cash_orders: { Args: never; Returns: Json }
      get_daily_cash_orders_last_month: { Args: never; Returns: Json }
      get_daily_new_layaway_sales: {
        Args: { currency_mode?: string }
        Returns: Json
      }
      get_daily_new_layaway_sales_last_month: {
        Args: { currency_mode?: string }
        Returns: Json
      }
      get_forecast_6m: {
        Args: never
        Returns: {
          currency: string
          installments: number
          month: string
          remaining: number
        }[]
      }
      get_forecast_drilldown: {
        Args: { p_month: string }
        Returns: {
          account_id: string
          account_status: string
          actual_remaining: number
          computed_status: string
          currency: string
          customer_name: string
          due_date: string
          invoice_number: string
          schedule_id: string
        }[]
      }
      get_monthly_analytics: {
        Args: never
        Returns: {
          collected_jpy: number
          forfeited_jpy: number
          month: string
          penalties_jpy: number
        }[]
      }
      get_monthly_sales: {
        Args: { currency_mode?: string; months_back?: number }
        Returns: Json
      }
      get_monthly_tracking_export: {
        Args: { p_month: number; p_year: number }
        Returns: {
          currency: string
          customer_name: string
          invoice_number: string
          month_paid_jpy: Json
          order_date: string
          payment_plan_months: number
          total_jpy: number
        }[]
      }
      get_recent_qualifying_order: {
        Args: { p_customer_id: string; p_lookback_days?: number }
        Returns: {
          account_id: string
          cash_order_id: string
          confirmed_at: string
          currency: string
          invoice_number: string
          loyalty_jpy_amount: number
          source_kind: string
          total_amount: number
        }[]
      }
      get_staff_performance: { Args: { months_back?: number }; Returns: Json }
      get_top_outstanding_customers: {
        Args: never
        Returns: {
          account_count: number
          customer_id: string
          early_payment_rate: number
          full_name: string
          penalty_count: number
          score: number
          total_paid_jpy: number
        }[]
      }
      get_tracking_for_invoices: {
        Args: { p_invoices: string[] }
        Returns: {
          country: string
          currency: string
          full_name: string
          invoice_number: string
          month_paid_jpy: Json
          order_date: string
          status: string
        }[]
      }
      get_trade_kpis: { Args: never; Returns: Json }
      get_trade_monthly_trends: {
        Args: { p_months_back?: number }
        Returns: {
          month: string
          trade_count: number
          trade_value_jpy: number
        }[]
      }
      get_unpaid_schedule: { Args: { p_account_id: string }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      insert_lot_and_extend: {
        Args: {
          p_amount: number
          p_earned_at?: string
          p_expires_at?: string
          p_member_id: string
          p_notes?: string
          p_source_reference: string
          p_source_type: Database["public"]["Enums"]["loyalty_lot_source_type"]
        }
        Returns: string
      }
      insert_payment_submission_guarded: {
        Args: {
          p_account_id: string
          p_customer_id: string
          p_force?: boolean
          p_notes: string
          p_payment_date: string
          p_payment_method: string
          p_reference_number: string
          p_sender_name: string
          p_submission_type: string
          p_submitted_amount: number
        }
        Returns: Json
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
      issue_store_credit_atomic: {
        Args: {
          p_amount: number
          p_currency: Database["public"]["Enums"]["account_currency"]
          p_customer_id: string
          p_notes?: string
          p_source?: string
          p_source_account_id?: string
          p_source_cash_order_id?: string
          p_source_refund_id?: string
          p_source_type: string
          p_user_email?: string
          p_user_id?: string
        }
        Returns: Json
      }
      monthly_inflow_by_plan_6m: {
        Args: never
        Returns: {
          jpy_total: number
          month: string
          payment_plan_months: number
        }[]
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      reconcile_failing_accounts: {
        Args: never
        Returns: {
          invoice_number: string
          new_remaining: number
          new_total_paid: number
          old_remaining: number
          old_total_paid: number
        }[]
      }
      redeem_store_credit_atomic: {
        Args: {
          p_account_id?: string
          p_amount?: number
          p_cash_order_id?: string
          p_customer_id?: string
          p_preview?: boolean
          p_user_email?: string
          p_user_id?: string
        }
        Returns: Json
      }
      restore_lots_for_redemption: {
        Args: { p_redemption_id: string }
        Returns: number
      }
      restore_loyalty_points: {
        Args: { p_created_by_user_id?: string; p_revoke_transaction_id: string }
        Returns: string
      }
      revalidate_account_from_vault: {
        Args: { p_invoice_number: string }
        Returns: Json
      }
      revoke_loyalty_points: {
        Args: {
          p_account_id?: string
          p_cash_order_id?: string
          p_created_by_user_id?: string
          p_invoice_number?: string
          p_member_id: string
          p_notes?: string
          p_payment_id?: string
          p_source_reference: string
          p_spend_jpy: number
        }
        Returns: string
      }
      revoke_loyalty_points_partial: {
        Args: {
          p_cash_order_id?: string
          p_created_by_user_id?: string
          p_customer_id: string
          p_notes?: string
          p_refund_id?: string
          p_refund_spend_jpy: number
          p_source_reference: string
        }
        Returns: Json
      }
      staff_display_name: { Args: { p_user_id: string }; Returns: string }
      staff_notify: {
        Args: {
          p_account_id: string
          p_body: string
          p_customer_id: string
          p_invoice: string
          p_meta?: Json
          p_title: string
          p_type: string
        }
        Returns: undefined
      }
      timesheet_can_view_all: { Args: { uid: string }; Returns: boolean }
      unwaive_penalty_atomic: {
        Args: { p_user_email: string; p_user_id: string; p_waiver_id: string }
        Returns: Json
      }
      validate_bulk_import: { Args: { p_rows: Json }; Returns: Json }
      void_redemption_atomic: {
        Args: {
          p_redemption_id: string
          p_user_email: string
          p_user_id: string
          p_void_reason: string
        }
        Returns: Json
      }
      void_store_credit_lot_atomic: {
        Args: {
          p_lot_id: string
          p_reason: string
          p_user_email?: string
          p_user_id?: string
        }
        Returns: Json
      }
    }
    Enums: {
      account_currency: "PHP" | "JPY"
      account_status:
        | "active"
        | "completed"
        | "cancelled"
        | "overdue"
        | "forfeited"
        | "final_settlement"
        | "reactivated"
        | "extension_active"
        | "final_forfeited"
      allocation_type: "penalty" | "installment"
      app_role:
        | "admin"
        | "staff"
        | "finance"
        | "csr"
        | "customer"
        | "live_agent"
      cash_order_status: "pending" | "completed" | "cancelled" | "expired"
      clv_tier: "bronze" | "silver" | "gold" | "vip"
      loyalty_lot_source_type:
        | "order_earn"
        | "birthday_bonus"
        | "promo_bonus"
        | "admin_adjust"
        | "refund_restoration"
      loyalty_redemption_status: "pending" | "confirmed" | "cancelled"
      loyalty_redemption_type:
        | "new_order_discount"
        | "shipping_fee"
        | "service_fee"
        | "catalog_reward"
      loyalty_transaction_type:
        | "earned"
        | "bonus"
        | "redeemed"
        | "expired"
        | "adjusted"
        | "refunded"
        | "revoked"
        | "enrolled"
        | "tier_changed"
        | "status_changed"
        | "admin_edited"
        | "birthday_bonus"
      penalty_fee_status: "unpaid" | "paid" | "waived"
      penalty_stage: "week1" | "week2"
      resale_status: "In stock" | "Sold"
      risk_level: "low" | "medium" | "high"
      schedule_status:
        | "pending"
        | "partially_paid"
        | "paid"
        | "overdue"
        | "cancelled"
      service_status:
        | "Logged"
        | "Process"
        | "On-going"
        | "Pending"
        | "Cancelled"
        | "Completed"
      service_type:
        | "Ring Resize"
        | "Certificate"
        | "Repair"
        | "Bracelet Resize"
        | "Polishing"
        | "Watch Polishing"
        | "Color Change"
      store_credit_lot_status: "active" | "consumed" | "expired" | "voided"
      store_credit_txn_type:
        | "issued"
        | "redeemed"
        | "expired"
        | "voided"
        | "adjusted"
      submission_status:
        | "submitted"
        | "under_review"
        | "confirmed"
        | "rejected"
        | "needs_clarification"
        | "cancelled"
      user_status: "active" | "inactive" | "suspended"
      waiver_status: "pending" | "approved" | "rejected" | "auto_unwaived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_currency: ["PHP", "JPY"],
      account_status: [
        "active",
        "completed",
        "cancelled",
        "overdue",
        "forfeited",
        "final_settlement",
        "reactivated",
        "extension_active",
        "final_forfeited",
      ],
      allocation_type: ["penalty", "installment"],
      app_role: ["admin", "staff", "finance", "csr", "customer", "live_agent"],
      cash_order_status: ["pending", "completed", "cancelled", "expired"],
      clv_tier: ["bronze", "silver", "gold", "vip"],
      loyalty_lot_source_type: [
        "order_earn",
        "birthday_bonus",
        "promo_bonus",
        "admin_adjust",
        "refund_restoration",
      ],
      loyalty_redemption_status: ["pending", "confirmed", "cancelled"],
      loyalty_redemption_type: [
        "new_order_discount",
        "shipping_fee",
        "service_fee",
        "catalog_reward",
      ],
      loyalty_transaction_type: [
        "earned",
        "bonus",
        "redeemed",
        "expired",
        "adjusted",
        "refunded",
        "revoked",
        "enrolled",
        "tier_changed",
        "status_changed",
        "admin_edited",
        "birthday_bonus",
      ],
      penalty_fee_status: ["unpaid", "paid", "waived"],
      penalty_stage: ["week1", "week2"],
      resale_status: ["In stock", "Sold"],
      risk_level: ["low", "medium", "high"],
      schedule_status: [
        "pending",
        "partially_paid",
        "paid",
        "overdue",
        "cancelled",
      ],
      service_status: [
        "Logged",
        "Process",
        "On-going",
        "Pending",
        "Cancelled",
        "Completed",
      ],
      service_type: [
        "Ring Resize",
        "Certificate",
        "Repair",
        "Bracelet Resize",
        "Polishing",
        "Watch Polishing",
        "Color Change",
      ],
      store_credit_lot_status: ["active", "consumed", "expired", "voided"],
      store_credit_txn_type: [
        "issued",
        "redeemed",
        "expired",
        "voided",
        "adjusted",
      ],
      submission_status: [
        "submitted",
        "under_review",
        "confirmed",
        "rejected",
        "needs_clarification",
        "cancelled",
      ],
      user_status: ["active", "inactive", "suspended"],
      waiver_status: ["pending", "approved", "rejected", "auto_unwaived"],
    },
  },
} as const

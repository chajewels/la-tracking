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
      customers: {
        Row: {
          created_at: string
          customer_code: string
          email: string | null
          facebook_name: string | null
          full_name: string
          id: string
          location: string | null
          messenger_link: string | null
          mobile_number: string | null
          notes: string | null
          preferred_contact_method: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_code: string
          email?: string | null
          facebook_name?: string | null
          full_name: string
          id?: string
          location?: string | null
          messenger_link?: string | null
          mobile_number?: string | null
          notes?: string | null
          preferred_contact_method?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_code?: string
          email?: string | null
          facebook_name?: string | null
          full_name?: string
          id?: string
          location?: string | null
          messenger_link?: string | null
          mobile_number?: string | null
          notes?: string | null
          preferred_contact_method?: string | null
          updated_at?: string
        }
        Relationships: []
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
      layaway_accounts: {
        Row: {
          accepted_by_user_id: string | null
          agreement_acceptance_date: string | null
          agreement_version: string | null
          created_at: string
          created_by_user_id: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          downpayment_amount: number
          end_date: string | null
          id: string
          invoice_number: string
          notes: string | null
          order_date: string
          payment_plan_months: number
          remaining_balance: number
          status: Database["public"]["Enums"]["account_status"]
          total_amount: number
          total_paid: number
          updated_at: string
        }
        Insert: {
          accepted_by_user_id?: string | null
          agreement_acceptance_date?: string | null
          agreement_version?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency: Database["public"]["Enums"]["account_currency"]
          customer_id: string
          downpayment_amount?: number
          end_date?: string | null
          id?: string
          invoice_number: string
          notes?: string | null
          order_date: string
          payment_plan_months: number
          remaining_balance: number
          status?: Database["public"]["Enums"]["account_status"]
          total_amount: number
          total_paid?: number
          updated_at?: string
        }
        Update: {
          accepted_by_user_id?: string | null
          agreement_acceptance_date?: string | null
          agreement_version?: string | null
          created_at?: string
          created_by_user_id?: string | null
          currency?: Database["public"]["Enums"]["account_currency"]
          customer_id?: string
          downpayment_amount?: number
          end_date?: string | null
          id?: string
          invoice_number?: string
          notes?: string | null
          order_date?: string
          payment_plan_months?: number
          remaining_balance?: number
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
        ]
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
        ]
      }
      penalty_waiver_requests: {
        Row: {
          account_id: string
          approved_at: string | null
          approved_by_user_id: string | null
          created_at: string
          id: string
          penalty_amount: number
          penalty_fee_id: string
          reason: string
          rejected_at: string | null
          requested_by_user_id: string
          schedule_id: string
          status: Database["public"]["Enums"]["waiver_status"]
          updated_at: string
        }
        Insert: {
          account_id: string
          approved_at?: string | null
          approved_by_user_id?: string | null
          created_at?: string
          id?: string
          penalty_amount: number
          penalty_fee_id: string
          reason: string
          rejected_at?: string | null
          requested_by_user_id: string
          schedule_id: string
          status?: Database["public"]["Enums"]["waiver_status"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          approved_at?: string | null
          approved_by_user_id?: string | null
          created_at?: string
          id?: string
          penalty_amount?: number
          penalty_fee_id?: string
          reason?: string
          rejected_at?: string | null
          requested_by_user_id?: string
          schedule_id?: string
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
        ]
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
        ]
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
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      account_currency: "PHP" | "JPY"
      account_status:
        | "active"
        | "completed"
        | "cancelled"
        | "overdue"
        | "forfeited"
      allocation_type: "penalty" | "installment"
      app_role: "admin" | "staff" | "finance" | "csr"
      clv_tier: "bronze" | "silver" | "gold" | "vip"
      penalty_fee_status: "unpaid" | "paid" | "waived"
      penalty_stage: "week1" | "week2"
      risk_level: "low" | "medium" | "high"
      schedule_status:
        | "pending"
        | "partially_paid"
        | "paid"
        | "overdue"
        | "cancelled"
      user_status: "active" | "inactive" | "suspended"
      waiver_status: "pending" | "approved" | "rejected"
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
      ],
      allocation_type: ["penalty", "installment"],
      app_role: ["admin", "staff", "finance", "csr"],
      clv_tier: ["bronze", "silver", "gold", "vip"],
      penalty_fee_status: ["unpaid", "paid", "waived"],
      penalty_stage: ["week1", "week2"],
      risk_level: ["low", "medium", "high"],
      schedule_status: [
        "pending",
        "partially_paid",
        "paid",
        "overdue",
        "cancelled",
      ],
      user_status: ["active", "inactive", "suspended"],
      waiver_status: ["pending", "approved", "rejected"],
    },
  },
} as const

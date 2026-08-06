import type { ProjectConfigurationEntry } from "@/core/types";

export type SettingsTabId = "interaction" | "display" | "project" | "script" | "save" | "client";

export interface SettingsField {
  code: string;
  label: string;
  control: "text" | "number" | "boolean" | "enum" | "color";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface SettingsGroup {
  title: string;
  fields: SettingsField[];
}

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  warning?: string;
  groups: SettingsGroup[];
}

const yesNo = (code: string, label: string): SettingsField => ({ code, label, control: "boolean" });
const integer = (code: string, label: string, min?: number, max?: number): SettingsField => ({
  code,
  label,
  control: "number",
  min,
  max,
});

export const projectSettingsTabs: SettingsTab[] = [
  {
    id: "interaction",
    label: "交互与输出",
    groups: [
      {
        title: "输入与菜单",
        fields: [
          yesNo("UseMenu", "显示菜单"),
          yesNo("UseMouse", "启用鼠标操作"),
          yesNo("AllowLongInputByMouse", "鼠标允许长输入"),
          yesNo("Ctrl_Z_Enabled", "启用 Ctrl+Z 撤销"),
        ],
      },
      {
        title: "滚动与历史",
        fields: [
          integer("ScrollHeight", "每次滚动行数", 1),
          integer("MaxLog", "历史日志行数", 500),
          yesNo("ButtonWrap", "按钮保持整行"),
          yesNo("CompatiLinefeedAs1739", "兼容旧版换行"),
        ],
      },
      {
        title: "PRINTC 布局",
        fields: [
          integer("PrintCPerLine", "每行项目数", 1),
          integer("PrintCLength", "项目字符宽度", 1),
        ],
      },
    ],
  },
  {
    id: "display",
    label: "显示",
    groups: [
      {
        title: "窗口与主视口",
        fields: [
          yesNo("WindowMaximixed", "启动时最大化"),
          integer("WindowX", "主视口宽度", 128, 2_147_483_647),
          integer("WindowY", "主视口高度", 128, 2_147_483_647),
        ],
      },
      {
        title: "字体与行高",
        fields: [
          { code: "FontName", label: "游戏字体", control: "text" },
          integer("FontSize", "字号", 8),
          integer("LineHeight", "行高", 8),
        ],
      },
      {
        title: "颜色",
        fields: [
          { code: "ForeColor", label: "文字颜色", control: "color" },
          { code: "BackColor", label: "背景颜色", control: "color" },
          { code: "FocusColor", label: "选中颜色", control: "color" },
        ],
      },
    ],
  },
  {
    id: "project",
    label: "项目加载",
    warning: "这些设置会改变项目文件的加载和解析方式。应用后需要重新启动项目。",
    groups: [
      {
        title: "文件加载",
        fields: [
          yesNo("UseRenameFile", "使用 _Rename.csv"),
          yesNo("UseReplaceFile", "使用 _Replace.csv"),
          yesNo("SearchSubdirectory", "搜索子目录"),
          yesNo("SortWithFilename", "按文件名排序"),
        ],
      },
      {
        title: "兼容与数据",
        fields: [
          yesNo("CompatiCALLNAME", "空 CALLNAME 使用 NAME"),
          yesNo("CompatiSPChara", "启用 SP 角色"),
          yesNo("UseERD", "启用 ERD"),
          yesNo("VarsizeDimConfig", "VARSIZE 采用 ERD 维度"),
          yesNo("SystemAllowFullSpace", "全角空格视为空白"),
          {
            code: "useLanguage",
            label: "东亚文本编码",
            control: "enum",
            options: [
              { value: "JAPANESE", label: "日语" },
              { value: "KOREAN", label: "韩语" },
              { value: "CHINESE_HANS", label: "简体中文" },
              { value: "CHINESE_HANT", label: "繁体中文" },
            ],
          },
          { code: "ReplaceContinuationBR", label: "行连接换行替换文本", control: "text" },
        ],
      },
    ],
  },
  {
    id: "script",
    label: "脚本兼容",
    warning: "这些设置会改变脚本分析和兼容规则。应用后需要重新启动项目。",
    groups: [
      {
        title: "分析规则",
        fields: [
          yesNo("IgnoreCase", "忽略大小写"),
          yesNo("IgnoreUncalledFunction", "忽略未调用函数"),
          yesNo("AllowFunctionOverloading", "允许覆盖系统函数"),
          yesNo("WarnFunctionOverloading", "覆盖系统函数时警告"),
          integer("DisplayWarningLevel", "最低警告级别", 0, 255),
        ],
      },
      {
        title: "警告与调用",
        fields: [
          warningField("FunctionNotFoundWarning", "函数未找到"),
          warningField("FunctionNotCalledWarning", "函数未调用"),
          yesNo("CompatiCallEvent", "允许 CALL 事件函数"),
          yesNo("CompatiFuncArgOptional", "允许省略全部函数参数"),
          yesNo("CompatiFuncArgAutoConvert", "自动转换函数参数"),
          yesNo("SystemIgnoreTripleSymbol", "FORM 中不展开三连符号"),
        ],
      },
    ],
  },
  {
    id: "save",
    label: "存档",
    warning: "更改存档格式可能影响与其他客户端的兼容性。应用后需要重新启动项目。",
    groups: [
      {
        title: "存档行为",
        fields: [
          yesNo("AutoSave", "启用自动存档"),
          integer("SaveDataNos", "每页存档数量", 20, 80),
          yesNo("SystemSaveInBinary", "使用二进制存档"),
          yesNo("ZipSaveData", "压缩二进制存档"),
          yesNo("EnglishConfigOutput", "以英文输出配置"),
        ],
      },
    ],
  },
];

function warningField(code: string, label: string): SettingsField {
  return {
    code,
    label,
    control: "enum",
    options: [
      { value: "IGNORE", label: "忽略" },
      { value: "LATER", label: "延后显示" },
      { value: "ONCE", label: "每文件一次" },
      { value: "DISPLAY", label: "立即显示" },
    ],
  };
}

export function availableProjectTabs(entries: ProjectConfigurationEntry[]): SettingsTab[] {
  const codes = new Set(entries.map((entry) => entry.code));
  return projectSettingsTabs
    .map((tab) => ({
      ...tab,
      groups: tab.groups
        .map((group) => ({
          ...group,
          fields: group.fields.filter((field) => codes.has(field.code)),
        }))
        .filter((group) => group.fields.length > 0),
    }))
    .filter((tab) => tab.groups.length > 0);
}

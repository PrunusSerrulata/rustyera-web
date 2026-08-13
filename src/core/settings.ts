import type { ProjectConfigurationEntry } from "@/core/types";

import { integer, range, warningField, yesNo } from "./settings/fields";

export type SettingsTabId = "interaction" | "display" | "project" | "script" | "save";

export interface SettingsField {
  code: string;
  label: string;
  description: string;
  control: "text" | "number" | "boolean" | "enum" | "color" | "range";
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

export const projectSettingsTabs: SettingsTab[] = [
  {
    id: "interaction",
    label: "交互与输出",
    groups: [
      {
        title: "输入与菜单",
        fields: [
          yesNo("UseMenu", "显示菜单", "控制游戏运行时是否显示应用菜单栏。"),
          yesNo("UseMouse", "启用鼠标操作", "允许使用鼠标点击游戏按钮并提交交互。"),
          yesNo("AllowLongInputByMouse", "鼠标允许长输入", "允许鼠标向 ONEINPUT 提交多个字符。"),
          yesNo("Ctrl_Z_Enabled", "启用 Ctrl+Z 撤销", "允许用 Ctrl+Z 撤销最近一次游戏输入。"),
        ],
      },
      {
        title: "滚动与历史",
        fields: [
          integer("ScrollHeight", "每次滚动行数", "设置每次滚动操作移动的游戏文本行数。", 1),
          integer("MaxLog", "历史日志行数", "设置游戏历史记录最多保留的文本行数。", 500),
          yesNo("ButtonWrap", "按钮保持整行", "避免在游戏按钮内容中间自动折行。"),
          yesNo(
            "CompatiLinefeedAs1739",
            "兼容旧版换行",
            "重现 Emuera 1.739 及更早版本的非按钮文本换行方式。",
          ),
        ],
      },
      {
        title: "PRINTC 布局",
        fields: [
          integer("PrintCPerLine", "每行项目数", "设置 PRINTC 输出在每行排列的项目数量。", 1),
          integer("PrintCLength", "项目字符宽度", "设置每个 PRINTC 项目占用的字符列宽。", 1),
        ],
      },
      {
        title: "声音",
        fields: [
          range("AudioVolume", "游戏音量（%）", "调整游戏音频的输出音量，0 为静音。", 0, 100),
        ],
      },
      {
        title: "输出文本",
        fields: [
          yesNo(
            "ReplaceFullWidthSpaces",
            "以两个半角空格替代全角空格",
            "显示游戏文本时，将每个全角空格替换为两个半角空格。",
          ),
          {
            code: "CharacterWidthMode",
            label: "字符列宽计算模式",
            description:
              "统一控制游戏格式化和显示列宽；自动模式兼容 Era 的 CJK 字符及 emoji 类图形符号。",
            control: "enum",
            options: [
              { value: "AUTOMATIC", label: "自动（Era 与图形符号兼容）" },
              { value: "AMBIGUOUS_NARROW", label: "模糊字符按窄字符" },
              { value: "AMBIGUOUS_WIDE", label: "模糊字符按宽字符" },
            ],
          },
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
          yesNo("WindowMaximixed", "启动时最大化", "启动桌面客户端时将主窗口最大化。"),
          integer("WindowX", "主视口宽度", "设置游戏主视口宽度（像素）。", 128, 2_147_483_647),
          integer("WindowY", "主视口高度", "设置游戏主视口高度（像素）。", 128, 2_147_483_647),
        ],
      },
      {
        title: "字体与行高",
        fields: [
          {
            code: "FontName",
            label: "游戏字体",
            description: "设置游戏输出文本使用的字体名称。",
            control: "text",
          },
          integer("FontSize", "字号", "设置游戏输出文本的字号（像素）。", 8),
          integer("LineHeight", "行高", "设置每行游戏输出文本占用的高度（像素）。", 8),
        ],
      },
      {
        title: "颜色",
        fields: [
          {
            code: "ForeColor",
            label: "文字颜色",
            description: "设置游戏输出文本的默认颜色。",
            control: "color",
          },
          {
            code: "BackColor",
            label: "背景颜色",
            description: "设置游戏主视口的背景颜色。",
            control: "color",
          },
          {
            code: "FocusColor",
            label: "选中文字颜色",
            description: "设置游戏按钮获得焦点或被选中时的文字颜色。",
            control: "color",
          },
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
          yesNo(
            "UseRenameFile",
            "使用 _Rename.csv",
            "加载项目时应用 _Rename.csv 中的名称替换规则。",
          ),
          yesNo(
            "UseReplaceFile",
            "使用 _Replace.csv",
            "加载项目时应用 _Replace.csv 中的文本替换规则。",
          ),
          yesNo("SearchSubdirectory", "搜索子目录", "加载项目时递归搜索子目录中的脚本和数据文件。"),
          yesNo("SortWithFilename", "按文件名排序", "按文件名顺序加载项目脚本和数据文件。"),
        ],
      },
      {
        title: "兼容与数据",
        fields: [
          yesNo("CompatiCALLNAME", "空 CALLNAME 使用 NAME", "角色 CALLNAME 为空时改用 NAME 的值。"),
          yesNo("CompatiSPChara", "启用 SP 角色", "启用 Emuera 的 SP 角色兼容行为。"),
          yesNo("UseERD", "启用 ERD", "加载并应用项目中的 ERD 变量定义文件。"),
          yesNo(
            "VarsizeDimConfig",
            "VARSIZE 采用 ERD 维度",
            "让 VARSIZE 使用 ERD 的一基维度编号。",
          ),
          yesNo("SystemAllowFullSpace", "全角空格视为空白", "解析脚本时将全角空格视为空白字符。"),
          {
            code: "useLanguage",
            label: "东亚文本编码",
            description: "指定项目使用的东亚语言编码和相应文本兼容规则。",
            control: "enum",
            options: [
              { value: "JAPANESE", label: "日语" },
              { value: "KOREAN", label: "韩语" },
              { value: "CHINESE_HANS", label: "简体中文" },
              { value: "CHINESE_HANT", label: "繁体中文" },
            ],
          },
          {
            code: "ReplaceContinuationBR",
            label: "行连接换行替换文本",
            description: "设置连接脚本行时用于替代原换行位置的文本。",
            control: "text",
          },
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
          yesNo("IgnoreCase", "忽略大小写", "解析标识符和函数名时不区分字母大小写。"),
          yesNo("IgnoreUncalledFunction", "忽略未调用函数", "忽略未调用函数的处理和警告。"),
          yesNo(
            "AllowFunctionOverloading",
            "允许覆盖系统函数",
            "允许用户函数使用与系统函数相同的名称。",
          ),
          yesNo(
            "WarnFunctionOverloading",
            "覆盖系统函数时警告",
            "用户函数覆盖系统函数时生成警告。",
          ),
          integer(
            "DisplayWarningLevel",
            "最低警告级别",
            "仅显示达到此级别或更高级别的脚本警告。",
            0,
            255,
          ),
        ],
      },
      {
        title: "警告与调用",
        fields: [
          warningField("FunctionNotFoundWarning", "函数未找到", "设置引用不存在函数时的警告方式。"),
          warningField(
            "FunctionNotCalledWarning",
            "函数未调用",
            "设置函数从未被调用时的警告方式。",
          ),
          yesNo("CompatiCallEvent", "允许 CALL 事件函数", "允许通过 CALL 系列命令调用事件函数。"),
          yesNo(
            "CompatiFuncArgOptional",
            "允许省略全部函数参数",
            "允许调用用户函数时省略其声明的全部参数。",
          ),
          yesNo(
            "CompatiFuncArgAutoConvert",
            "自动转换函数参数",
            "为用户函数的字符串参数自动补充 TOSTR。",
          ),
          yesNo(
            "SystemIgnoreTripleSymbol",
            "FORM 中不展开三连符号",
            "在 FORM 文本中保留三连符号，不将其作为特殊展开语法处理。",
          ),
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
          yesNo("AutoSave", "启用自动存档", "在商店事件结束后执行自动保存。"),
          integer("SaveDataNos", "每页存档数量", "设置存档选择界面每页显示的存档槽数量。", 20, 80),
          yesNo("SystemSaveInBinary", "使用二进制存档", "以二进制格式写入游戏存档。"),
          yesNo("ZipSaveData", "压缩二进制存档", "压缩二进制存档以减少占用空间。"),
        ],
      },
    ],
  },
];

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

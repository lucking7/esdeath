import process from 'node:process';
import path from 'node:path';
import type { Span } from '../trace';
import { HostnameSmolTrie } from '../utils/data-structures/trie';
import { not, nullthrow } from 'foxts/guard';
import { createRetrieKeywordFilter as createKeywordFilter } from 'foxts/retrie';
import type { BaseWriteStrategy, RuleDropSummary } from '../core/output/writing-strategy/base';
import type { RulePlatform } from '../core/output/rule-support-matrix';
import { createStrategiesForTargets, normalizeTargets } from './platform-config';
import type { SupportedPlatform } from './platform-config';
import type { FileConfig, RuleGroup, SpecialRuleConfig } from './rule-source-types';
import { cleanPolicy } from './policy-cleaner';
import { smartConvertRule } from './misc';
import { RuleLineUtils } from '../utils/validation/validators';
import { merge as mergeCidr } from 'fast-cidr-tools';

const RULE_TYPE_MAP: Record<string, string> = {
  DOMAIN: 'domain',
  'DOMAIN-SUFFIX': 'domain-suffix',
  'DOMAIN-KEYWORD': 'domain-keyword',
  'DOMAIN-WILDCARD': 'domain-wildcard',
  'IP-CIDR': 'ip-cidr',
  'IP-CIDR6': 'ip-cidr6',
  'IP-ASN': 'ip-asn',
  'USER-AGENT': 'user-agent',
  'PROCESS-NAME': 'process-name',
  'URL-REGEX': 'url-regex',
  GEOIP: 'geoip',
  'SRC-IP': 'source-ip-cidr',
  'SRC-IP-CIDR': 'source-ip-cidr',
  'SRC-IP-CIDR6': 'source-ip-cidr',
  'SRC-PORT': 'source-port',
  'DEST-PORT': 'destination-port',
  'DST-PORT': 'destination-port',
  PROTOCOL: 'protocol',
  NETWORK: 'protocol',
};

type EnhancedFileConfig = FileConfig & {
  validate?: boolean;
};

/**
 * Normalizes rules, owns canonical state, and delegates platform output to writing strategies.
 */
export class EnhancedFileOutput {
  private readonly targets: SupportedPlatform[];
  private readonly strategies: BaseWriteStrategy[];
  private readonly span: Span;

  private readonly domainTrie = new HostnameSmolTrie(null);
  private readonly wildcardTrie = new HostnameSmolTrie(null);
  private readonly domainKeywords = new Set<string>();
  private readonly userAgent = new Set<string>();
  private readonly processName = new Set<string>();
  private readonly processPath = new Set<string>();
  private readonly urlRegex = new Set<string>();
  private readonly ipcidr = new Set<string>();
  private readonly ipcidrNoResolve = new Set<string>();
  private readonly ipasn = new Set<string>();
  private readonly ipasnNoResolve = new Set<string>();
  private readonly ipcidr6 = new Set<string>();
  private readonly ipcidr6NoResolve = new Set<string>();
  private readonly geoip = new Set<string>();
  private readonly groipNoResolve = new Set<string>();
  private readonly sourceIpOrCidr = new Set<string>();
  private readonly sourcePort = new Set<string>();
  private readonly destPort = new Set<string>();
  private readonly protocol = new Set<string>();
  private readonly otherRules: string[] = [];

  private title: string | null = null;
  private description: string[] | null = null;
  private readonly date = new Date();
  private strategiesWritten = false;

  private readonly stats = {
    inputDomains: 0,
    inputCIDRs: 0,
    inputOthers: 0,
  };

  private readonly config: {
    keepComments: boolean;
    keepEmptyLines: boolean;
    keepInlineComments: boolean;
    formatConversion: boolean;
    applyNoResolve: boolean;
    validate: boolean;
    dedup: boolean;
    sort: boolean;
  };

  constructor(
    span: Span,
    private readonly id: string,
    _ruleType: 'domainset' | 'non_ip' | 'ip' | 'mixed' | '',
    targets: SupportedPlatform[] = ['surge'],
    private readonly defaultPolicy: string | null = null,
    config?: Partial<EnhancedFileConfig>,
    outputBaseDir = 'public'
  ) {
    this.span = span.traceChild('RuleOutput#' + id);

    this.config = {
      keepComments: config?.keepComments ?? false,
      keepEmptyLines: config?.keepEmptyLines ?? false,
      keepInlineComments: config?.keepInlineComments ?? false,
      formatConversion: config?.formatConversion ?? true,
      applyNoResolve: config?.applyNoResolve ?? false,
      validate: config?.validate ?? false,
      dedup: config?.dedup ?? true,
      sort: config?.sort ?? true,
    };

    this.targets = normalizeTargets(targets);
    this.strategies = createStrategiesForTargets(this.targets, outputBaseDir);
  }

  /**
   * 智能添加规则 - 自动分发到 Trie/Set（自动去重+懒惰合并）
   */
  public addRawRule(rule: string): this {
    let trimmed = RuleLineUtils.stripYamlListPrefix(rule.trim());

    if (!trimmed) {
      if (this.config.keepEmptyLines) {
        this.otherRules.push('');
      }
      return this;
    }

    if (RuleLineUtils.shouldSkipLine(trimmed)) {
      if (this.config.keepComments && RuleLineUtils.isComment(trimmed)) {
        this.otherRules.push(trimmed);
      }
      return this;
    }

    if (!this.config.keepInlineComments) {
      trimmed = RuleLineUtils.removeInlineComment(trimmed);
    }

    let normalizedRule = trimmed;
    if (this.config.formatConversion) {
      normalizedRule = smartConvertRule(trimmed);
    }

    if (this.config.validate && !RuleLineUtils.isValidRule(normalizedRule)) {
      return this;
    }

    if (this.config.applyNoResolve) {
      normalizedRule = this.applyNoResolveParameter(normalizedRule);
    }

    const processedRule =
      this.defaultPolicy === null ? cleanPolicy(normalizedRule) : normalizedRule;

    const ruleType = this.detectRuleType(processedRule);

    switch (ruleType) {
      case 'domain': {
        const domain = this.extractDomain(processedRule);

        if (domain && !RuleLineUtils.isSukkaWatermark(domain)) {
          this.domainTrie.add(domain, false);
          if (process.env.DEBUG) this.stats.inputDomains++;
        }
        break;
      }

      case 'domain-suffix': {
        const suffix = this.extractDomain(processedRule);

        if (suffix && !RuleLineUtils.isSukkaWatermark(suffix)) {
          const lineFromDot = suffix.startsWith('.');
          this.domainTrie.add(
            lineFromDot ? suffix.slice(1) : suffix,
            true,
            null,
            lineFromDot ? 1 : 0
          );
          if (process.env.DEBUG) this.stats.inputDomains++;
        }
        break;
      }

      case 'domain-keyword': {
        const keyword = processedRule.split(',')[1]?.trim();
        if (keyword) {
          this.domainKeywords.add(keyword);
        }
        break;
      }

      case 'domain-wildcard': {
        const wildcard = this.extractDomain(processedRule);
        if (wildcard) {
          this.wildcardTrie.add(wildcard);
        }
        break;
      }

      case 'ip-cidr': {
        const cidr = processedRule.split(',')[1]?.trim();
        if (cidr) {
          const noResolve = processedRule.includes('no-resolve');
          (noResolve ? this.ipcidrNoResolve : this.ipcidr).add(cidr);
          if (process.env.DEBUG) this.stats.inputCIDRs++;
        }
        break;
      }

      case 'ip-cidr6': {
        const cidr6 = processedRule.split(',')[1]?.trim();
        if (cidr6) {
          const noResolve = processedRule.includes('no-resolve');
          (noResolve ? this.ipcidr6NoResolve : this.ipcidr6).add(cidr6);
          if (process.env.DEBUG) this.stats.inputCIDRs++;
        }
        break;
      }

      case 'ip-asn': {
        const asn = processedRule.split(',')[1]?.trim();
        if (asn) {
          const noResolve = processedRule.includes('no-resolve');
          (noResolve ? this.ipasnNoResolve : this.ipasn).add(asn);
        }
        break;
      }

      case 'user-agent': {
        const ua = processedRule.split(',')[1]?.trim();
        if (ua) {
          this.userAgent.add(ua);
        }
        break;
      }

      case 'process-name': {
        const proc = processedRule.split(',')[1]?.trim();
        if (proc) {
          if (proc.includes('/') || proc.includes('\\')) {
            this.processPath.add(proc);
          } else {
            this.processName.add(proc);
          }
        }
        break;
      }

      case 'url-regex': {
        const regex = processedRule.split(',').slice(1).join(',');
        if (regex) {
          this.urlRegex.add(regex);
        }
        break;
      }

      case 'geoip': {
        const value = processedRule.split(',')[1]?.trim();
        if (value) {
          const noResolve = processedRule.toLowerCase().includes('no-resolve');
          (noResolve ? this.groipNoResolve : this.geoip).add(value);
        } else {
          this.otherRules.push(processedRule);
        }
        break;
      }

      case 'source-ip-cidr': {
        const value = processedRule.split(',')[1]?.trim();
        if (value) this.sourceIpOrCidr.add(value);
        else this.otherRules.push(processedRule);
        break;
      }

      case 'source-port': {
        const value = processedRule.split(',')[1]?.trim();
        if (value) this.sourcePort.add(value);
        else this.otherRules.push(processedRule);
        break;
      }

      case 'destination-port': {
        const value = processedRule.split(',')[1]?.trim();
        if (value) this.destPort.add(value);
        else this.otherRules.push(processedRule);
        break;
      }

      case 'protocol': {
        const value = processedRule.split(',')[1]?.trim();
        if (value) this.protocol.add(value.toUpperCase());
        else this.otherRules.push(processedRule);
        break;
      }

      default:
        this.otherRules.push(processedRule);
        if (process.env.DEBUG) this.stats.inputOthers++;
    }

    return this;
  }

  /**
   * 检测规则类型
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- helper for rule classification does not depend on instance state
  private detectRuleType(rule: string): string {
    const comma = rule.indexOf(',');
    if (comma === -1) return 'other';
    const type = rule.slice(0, comma).toUpperCase().trim();
    return RULE_TYPE_MAP[type] || 'other';
  }

  /**
   * 提取域名部分
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- helper for extracting domain segment does not depend on instance state
  private extractDomain(rule: string): string {
    const parts = rule.split(',');
    return parts[1]?.trim() || '';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- pure transformation helper does not depend on instance state
  private applyNoResolveParameter(rule: string): string {
    const trimmed = rule.trim();
    const upperRule = trimmed.toUpperCase();

    const isIpRule =
      upperRule.startsWith('IP-CIDR,') ||
      upperRule.startsWith('IP-CIDR6,') ||
      upperRule.startsWith('GEOIP,') ||
      upperRule.startsWith('IP-ASN,') ||
      upperRule.startsWith('SRC-IP-CIDR,');

    if (!isIpRule) {
      return rule;
    }

    if (upperRule.includes('NO-RESOLVE')) {
      return rule;
    }

    return `${trimmed},no-resolve`;
  }

  /**
   * 批量添加规则（支持多种格式）
   */
  public addRules(rules: string[]): this {
    rules.forEach(rule => this.addRawRule(rule));
    return this;
  }

  /**
   * 完成添加 - 输出统计信息（DEBUG 模式）
   */
  async done() {
    await Promise.resolve(this);

    if (process.env.DEBUG) {
      const outputDomains = this.countTrieNodes();
      const outputCIDRs =
        this.ipcidr.size +
        this.ipcidrNoResolve.size +
        this.ipcidr6.size +
        this.ipcidr6NoResolve.size;

      console.log(`[${this.id}] Stats: ${this.stats.inputDomains} domains, ${this.stats.inputCIDRs} CIDRs, ${this.stats.inputOthers} others -> ~${outputDomains} domains, ${outputCIDRs} CIDRs`);
    }

    return this;
  }

  /**
   * 估算 Trie 节点数（近似输出规则数）
   */
  private countTrieNodes(): number {
    let count = 0;
    try {
      this.domainTrie.dump(() => count++);
    } catch {
      // Trie 可能为空
    }
    return count;
  }

  /**
   * Return the canonical, platform-independent ruleset size after normalization,
   * trie/set deduplication, and IPv4 CIDR merging. Platform support filtering is
   * intentionally not reflected in this logical count.
   */
  public getOutputSummary(): { id: string; platforms: SupportedPlatform[]; ruleCount: number } {
    let wildcardCount = 0;
    this.wildcardTrie.dump(() => wildcardCount++);

    const mergeCount = (values: Set<string>) => (
      values.size ? mergeCidr(Array.from(values), true).length : 0
    );
    const otherRuleCount = new Set(
      this.otherRules.filter(rule => {
        const trimmed = rule.trim();
        return trimmed.length > 0 && !RuleLineUtils.isComment(trimmed);
      })
    ).size;

    return {
      id: this.id,
      platforms: [...this.targets],
      ruleCount:
        this.countTrieNodes() +
        wildcardCount +
        this.domainKeywords.size +
        this.userAgent.size +
        this.processName.size +
        this.processPath.size +
        this.urlRegex.size +
        mergeCount(this.ipcidr) +
        mergeCount(this.ipcidrNoResolve) +
        this.ipcidr6.size +
        this.ipcidr6NoResolve.size +
        this.ipasn.size +
        this.ipasnNoResolve.size +
        this.geoip.size +
        this.groipNoResolve.size +
        this.sourceIpOrCidr.size +
        this.sourcePort.size +
        this.destPort.size +
        this.protocol.size +
        otherRuleCount,
    };
  }

  withTitle(title: string) {
    this.title = title;
    return this;
  }

  withDescription(description: string[] | readonly string[]) {
    this.description = description as string[];
    return this;
  }

  private writeToStrategies() {
    if (this.strategiesWritten) {
      throw new Error('Strategies already written');
    }

    this.strategiesWritten = true;

    // DOMAIN-KEYWORD covers matching DOMAIN, DOMAIN-SUFFIX, and DOMAIN-WILDCARD rules.
    const kwfilter = createKeywordFilter(Array.from(this.domainKeywords));

    if (this.strategies.filter(not(false)).length === 0) {
      throw new Error('No strategies to write ' + this.id);
    }

    const strategiesLen = this.strategies.length;

    this.domainTrie.dumpWithoutDot((domain, includeAllSubdomain) => {
      if (kwfilter(domain)) {
        return;
      }

      if (RuleLineUtils.isSukkaWatermark(domain)) {
        return;
      }

      this.wildcardTrie.whitelist(domain, includeAllSubdomain);

      for (let i = 0; i < strategiesLen; i++) {
        const strategy = this.strategies[i];
        if (includeAllSubdomain) {
          strategy.writeDomainSuffix(domain);
        } else {
          strategy.writeDomain(domain);
        }
      }
    }, true);

    // Write the keywords that cover the filtered domain rules.
    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];
      if (this.domainKeywords.size) {
        strategy.writeDomainKeywords(this.domainKeywords);
      }

      if (this.protocol.size) {
        strategy.writeProtocols(this.protocol);
      }
    }

    this.wildcardTrie.dumpWithoutDot(wildcard => {
      if (kwfilter(wildcard)) {
        return;
      }

      for (let i = 0; i < strategiesLen; i++) {
        const strategy = this.strategies[i];
        strategy.writeDomainWildcard(wildcard);
      }
    }, true);

    const sourceIpOrCidr = Array.from(this.sourceIpOrCidr);

    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];

      if (this.userAgent.size) {
        strategy.writeUserAgents(this.userAgent);
      }
      if (this.processName.size) {
        strategy.writeProcessNames(this.processName);
      }
      if (this.processPath.size) {
        strategy.writeProcessPaths(this.processPath);
      }

      if (this.sourceIpOrCidr.size) {
        strategy.writeSourceIpCidrs(sourceIpOrCidr);
      }

      if (this.sourcePort.size) {
        strategy.writeSourcePorts(this.sourcePort);
      }
      if (this.destPort.size) {
        strategy.writeDestinationPorts(this.destPort);
      }
      if (this.otherRules.length) {
        strategy.writeOtherRules(this.otherRules);
      }
      if (this.geoip.size) {
        strategy.writeGeoip(this.geoip, false);
      }
      if (this.urlRegex.size) {
        strategy.writeUrlRegexes(this.urlRegex);
      }
    }

    let ipcidr: string[] | null = null;
    let ipcidrNoResolve: string[] | null = null;
    let ipcidr6: string[] | null = null;
    let ipcidr6NoResolve: string[] | null = null;

    if (this.ipcidr.size) {
      ipcidr = mergeCidr(Array.from(this.ipcidr), true);
    }
    if (this.ipcidrNoResolve.size) {
      ipcidrNoResolve = mergeCidr(Array.from(this.ipcidrNoResolve), true);
    }
    if (this.ipcidr6.size) {
      ipcidr6 = Array.from(this.ipcidr6);
    }
    if (this.ipcidr6NoResolve.size) {
      ipcidr6NoResolve = Array.from(this.ipcidr6NoResolve);
    }

    for (let i = 0; i < strategiesLen; i++) {
      const strategy = this.strategies[i];
      // no-resolve
      if (ipcidrNoResolve) {
        strategy.writeIpCidrs(ipcidrNoResolve, true);
      }
      if (ipcidr6NoResolve) {
        strategy.writeIpCidr6s(ipcidr6NoResolve, true);
      }
      if (this.ipasnNoResolve.size) {
        strategy.writeIpAsns(this.ipasnNoResolve, true);
      }
      if (this.groipNoResolve.size) {
        strategy.writeGeoip(this.groipNoResolve, true);
      }

      // triggers DNS resolution
      if (ipcidr?.length) {
        strategy.writeIpCidrs(ipcidr, false);
      }
      if (ipcidr6?.length) {
        strategy.writeIpCidr6s(ipcidr6, false);
      }
      if (this.ipasn.size) {
        strategy.writeIpAsns(this.ipasn, false);
      }
    }
  }

  write(): Promise<unknown> {
    return this.span.traceChildAsync('write all', async childSpan => {
      await childSpan.traceChildAsync('done', () => this.done());

      childSpan.traceChildSync('write to strategies', () => this.writeToStrategies());

      return childSpan.traceChildAsync('output to disk', async childSpan => {
        const promises: Array<Promise<void>> = [];

        const descriptions = nullthrow(this.description, 'Missing description');

        for (let i = 0, len = this.strategies.length; i < len; i++) {
          const strategy = this.strategies[i];

          const basename = (strategy.overwriteFilename || this.id) + '.' + strategy.fileExtension;

          promises.push(
            childSpan.traceChildAsync('write ' + strategy.name, childSpan =>
              Promise.resolve(
                strategy.output(
                  childSpan,
                  nullthrow(this.title, 'Missing title'),
                  descriptions,
                  this.date,
                  path.join(
                    strategy.outputDir,
                    strategy.type ? path.join(strategy.type, basename) : basename
                  )
                )
              )
            )
          );
        }

        if (promises.length > 0) {
          await Promise.all(promises);
        }
      });
    });
  }

  async compile(): Promise<Array<string[] | null>> {
    await this.done();
    this.writeToStrategies();

    return this.strategies.reduce<Array<string[] | null>>((acc, strategy) => {
      acc.push(strategy.content);
      return acc;
    }, []);
  }

  public getRuleDropSummaries(): Partial<Record<RulePlatform, RuleDropSummary>> {
    const summaries: Partial<Record<RulePlatform, RuleDropSummary>> = {};
    for (const strategy of [...this.strategies].sort((a, b) => a.platform.localeCompare(b.platform))) {
      summaries[strategy.platform] = strategy.ruleDropSummary;
    }
    return summaries;
  }

  /**
   * 从配置创建增强输出器
   */
  static fromConfig(
    this: void,
    span: Span,
    config: RuleGroup | SpecialRuleConfig
  ): EnhancedFileOutput {
    const effectiveTargets = normalizeTargets('targets' in config ? config.targets : undefined);

    const defaultPolicy =
      'defaultPolicy' in config
        ? (config.defaultPolicy === undefined
          ? null
          : config.defaultPolicy)
        : null;

    return new EnhancedFileOutput(span, config.name, 'mixed', effectiveTargets, defaultPolicy);
  }
}
